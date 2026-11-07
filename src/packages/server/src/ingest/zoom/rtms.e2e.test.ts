import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import type { LiveSourceState } from "@specstorming/shared";
import { ZoomRtmsClient } from "./ZoomRtmsClient.ts";
import { CONTENT_TYPE_TEXT, MEDIA_TYPE_TRANSCRIPT, MSG_TYPE, STATUS_OK, handshakeSignature } from "./protocol.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const CREDS = { clientId: "cid", clientSecret: "csecret" };
const STREAM = { meetingUuid: "m-uuid", streamId: "stream-1" };

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Stub Zoom RTMS backend: a signaling server and a media server speaking just
 * enough of the protocol (verified message shapes from protocol.ts) to exercise
 * the client's full lifecycle without Zoom.
 */
async function startStub() {
  const received: { signaling: Record<string, unknown>[]; media: Record<string, unknown>[] } = {
    signaling: [],
    media: [],
  };
  const sockets: { signaling: WebSocket | null; media: WebSocket | null } = {
    signaling: null,
    media: null,
  };

  const mediaServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(mediaServer, "listening");
  const mediaPort = (mediaServer.address() as { port: number }).port;

  const signalingServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(signalingServer, "listening");
  const signalingPort = (signalingServer.address() as { port: number }).port;

  signalingServer.on("connection", (ws) => {
    sockets.signaling = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      received.signaling.push(msg);
      if (msg.msg_type === MSG_TYPE.SIGNALING_HAND_SHAKE_REQ) {
        const expected = handshakeSignature(CREDS.clientId, CREDS.clientSecret, STREAM.meetingUuid, STREAM.streamId);
        const ok = msg.signature === expected;
        ws.send(
          JSON.stringify({
            msg_type: MSG_TYPE.SIGNALING_HAND_SHAKE_RESP,
            status_code: ok ? STATUS_OK : 2,
            media_server: { server_urls: { all: `ws://127.0.0.1:${mediaPort}` } },
          }),
        );
      }
    });
  });

  mediaServer.on("connection", (ws) => {
    sockets.media = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      received.media.push(msg);
      if (msg.msg_type === MSG_TYPE.DATA_HAND_SHAKE_REQ) {
        ws.send(JSON.stringify({ msg_type: MSG_TYPE.DATA_HAND_SHAKE_RESP, status_code: STATUS_OK }));
      }
    });
  });

  return {
    received,
    sockets,
    serverUrl: `ws://127.0.0.1:${signalingPort}`,
    sendTranscript(text: string, userName: string, timestamp: number) {
      sockets.media?.send(
        JSON.stringify({
          msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
          content: text,
          user_name: userName,
          user_id: "u1",
          timestamp,
        }),
      );
    },
    sendKeepAlive(which: "signaling" | "media", timestamp: number) {
      sockets[which]?.send(JSON.stringify({ msg_type: MSG_TYPE.KEEP_ALIVE_REQ, timestamp }));
    },
    async close() {
      for (const server of [signalingServer, mediaServer]) {
        for (const client of server.clients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

test("full lifecycle against a stub RTMS backend", async () => {
  const stub = await startStub();
  const chunks: { speaker: string; text: string; ts?: string }[] = [];
  const statuses: { state: LiveSourceState; detail?: string }[] = [];
  const client = new ZoomRtmsClient({
    credentials: CREDS,
    sink: (c) => chunks.push(c),
    status: (state, detail) => statuses.push({ state, detail }),
    allowInsecureUrls: true,
    log: silentLog,
  });

  try {
    client.start({ ...STREAM, serverUrl: stub.serverUrl });
    assert.equal(statuses[0]?.state, "waiting");

    // Handshakes complete: waiting → connected, CLIENT_READY_ACK on the signaling socket.
    await waitFor(() => statuses.some((s) => s.state === "connected"));
    const readyAck = stub.received.signaling.find((m) => m.msg_type === MSG_TYPE.CLIENT_READY_ACK);
    assert.ok(readyAck, "CLIENT_READY_ACK sent on signaling socket");
    assert.equal(readyAck.rtms_stream_id, STREAM.streamId);

    // The data handshake subscribed to transcript-only text.
    const dataReq = stub.received.media.find((m) => m.msg_type === MSG_TYPE.DATA_HAND_SHAKE_REQ);
    assert.ok(dataReq);
    assert.equal(dataReq.media_type, MEDIA_TYPE_TRANSCRIPT);
    assert.equal(
      (dataReq.media_params as { transcript: { content_type: number } }).transcript.content_type,
      CONTENT_TYPE_TEXT,
    );

    // Keep-alives are answered on the socket they arrive on, echoing the timestamp.
    stub.sendKeepAlive("signaling", 111);
    stub.sendKeepAlive("media", 222);
    await waitFor(
      () =>
        stub.received.signaling.some((m) => m.msg_type === MSG_TYPE.KEEP_ALIVE_RESP && m.timestamp === 111) &&
        stub.received.media.some((m) => m.msg_type === MSG_TYPE.KEEP_ALIVE_RESP && m.timestamp === 222),
    );

    // Transcript messages become chunks; an exact re-delivery is suppressed.
    stub.sendTranscript("Payment failures spike on Mondays", "Maya", 1754130000000);
    await waitFor(() => chunks.length === 1);
    assert.equal(chunks[0].speaker, "Maya");
    stub.sendTranscript("Payment failures spike on Mondays", "Maya", 1754130000000);
    stub.sendTranscript("Refunds go through finance", "Sam", 1754130002000);
    await waitFor(() => chunks.length === 2);
    assert.equal(chunks[1].speaker, "Sam");

    // rtms_stopped-style teardown: sockets close, no reconnect, state leaves connected.
    client.stop("meeting ended");
    assert.deepEqual(statuses.at(-1), { state: "off", detail: "meeting ended" });
    assert.equal(client.active, false);
  } finally {
    client.stop();
    await stub.close();
  }
});

test("unexpected socket loss mid-meeting reports disconnected and reconnects", async () => {
  const stub = await startStub();
  const chunks: { speaker: string; text: string; ts?: string }[] = [];
  const statuses: { state: LiveSourceState; detail?: string }[] = [];
  const client = new ZoomRtmsClient({
    credentials: CREDS,
    sink: (c) => chunks.push(c),
    status: (state, detail) => statuses.push({ state, detail }),
    allowInsecureUrls: true,
    log: silentLog,
  });

  try {
    client.start({ ...STREAM, serverUrl: stub.serverUrl });
    await waitFor(() => statuses.some((s) => s.state === "connected"));

    // Kill the media socket server-side without an rtms_stopped event.
    stub.sockets.media?.terminate();
    await waitFor(() => statuses.some((s) => s.state === "disconnected"));

    // The client re-handshakes on its own (backoff starts at ~1s) and recovers.
    await waitFor(() => statuses.filter((s) => s.state === "connected").length >= 2, 10_000);

    // Post-reconnect: new utterances still flow.
    stub.sendTranscript("still here", "Maya", 1754130005000);
    await waitFor(() => chunks.length === 1);
  } finally {
    client.stop();
    await stub.close();
  }
});

/**
 * Drives the real server through a fake Zoom meeting without Zoom: boots stub
 * RTMS signaling/media servers, POSTs a signed `meeting.rtms_started` webhook,
 * streams transcript lines, then `meeting.rtms_stopped`.
 *
 * Usage (server must be running with ZOOM_RTMS_ENABLED=true and matching
 * ZOOM_CLIENT_ID/SECRET + ZOOM_WEBHOOK_SECRET_TOKEN):
 *   npx tsx scripts/rtms-stub-demo.ts [serverBase] [--keep-alive]
 * Defaults: serverBase http://127.0.0.1:8787. With --keep-alive the stub stays
 * up (no rtms_stopped) so the browser UI can be inspected in the live state.
 */
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CONTENT_TYPE_TEXT,
  MSG_TYPE,
  STATUS_OK,
  handshakeSignature,
} from "../src/ingest/zoom/protocol.ts";

const serverBase = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:8787";
const keepAlive = process.argv.includes("--keep-alive");

const CLIENT_ID = process.env.ZOOM_CLIENT_ID ?? "stub-client-id";
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET ?? "stub-client-secret";
const WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN ?? "stub-webhook-secret";
const MEETING_UUID = "stub-meeting-uuid";
const STREAM_ID = "stub-stream-1";

const LINES: [string, string][] = [
  ["Maya (Facilitator)", "Let's map what happens when an order is placed."],
  ["Sam (Payments)", "Payment authorized fires after the gateway confirms the charge."],
  ["Priya (Fulfillment)", "Once payment clears, the warehouse picks the order."],
  ["Sam (Payments)", "Refunds go through finance, not through the gateway."],
];

async function postWebhook(event: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", WEBHOOK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return fetch(`${serverBase}/api/zoom/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zm-signature": signature,
      "x-zm-request-timestamp": timestamp,
    },
    body,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- stub RTMS backend -----------------------------------------------------

const mediaServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(mediaServer, "listening");
const mediaPort = (mediaServer.address() as { port: number }).port;

const signalingServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(signalingServer, "listening");
const signalingPort = (signalingServer.address() as { port: number }).port;

let mediaSocket: WebSocket | null = null;

signalingServer.on("connection", (ws) => {
  console.log("[stub] signaling connection");
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg.msg_type === MSG_TYPE.SIGNALING_HAND_SHAKE_REQ) {
      const expected = handshakeSignature(CLIENT_ID, CLIENT_SECRET, MEETING_UUID, STREAM_ID);
      const ok = msg.signature === expected;
      console.log(`[stub] signaling handshake signature ${ok ? "ok" : "MISMATCH"}`);
      ws.send(
        JSON.stringify({
          msg_type: MSG_TYPE.SIGNALING_HAND_SHAKE_RESP,
          status_code: ok ? STATUS_OK : 2,
          media_server: { server_urls: { all: `ws://127.0.0.1:${mediaPort}` } },
        }),
      );
    }
    if (msg.msg_type === MSG_TYPE.CLIENT_READY_ACK) console.log("[stub] client ready");
  });
});

mediaServer.on("connection", (ws) => {
  console.log("[stub] media connection");
  mediaSocket = ws;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg.msg_type === MSG_TYPE.DATA_HAND_SHAKE_REQ) {
      const params = (msg.media_params as { transcript?: { content_type?: number } })?.transcript;
      console.log(
        `[stub] data handshake (media_type=${String(msg.media_type)}, content_type=${String(params?.content_type ?? CONTENT_TYPE_TEXT)})`,
      );
      ws.send(JSON.stringify({ msg_type: MSG_TYPE.DATA_HAND_SHAKE_RESP, status_code: STATUS_OK }));
    }
  });
});

// ---- drive the meeting -----------------------------------------------------

console.log(`[stub] signaling ws://127.0.0.1:${signalingPort}, media ws://127.0.0.1:${mediaPort}`);

const validation = await fetch(`${serverBase}/api/zoom/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "stub-plain" } }),
});
console.log("[demo] url_validation:", validation.status, await validation.text());

const started = await postWebhook({
  event: "meeting.rtms_started",
  event_ts: Date.now(),
  payload: {
    meeting_uuid: MEETING_UUID,
    rtms_stream_id: STREAM_ID,
    server_urls: `ws://127.0.0.1:${signalingPort}`,
  },
});
console.log("[demo] rtms_started webhook:", started.status, await started.text());

await sleep(1500);
const replayWhileLive = await fetch(`${serverBase}/api/session/replay/start`, { method: "POST" });
console.log("[demo] replay/start while live:", replayWhileLive.status, await replayWhileLive.text());

for (const [speaker, text] of LINES) {
  const socket = mediaSocket as WebSocket | null;
  if (!socket) break;
  socket.send(
    JSON.stringify({
      msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
      content: text,
      user_name: speaker,
      user_id: "stub-user",
      timestamp: Date.now(),
    }),
  );
  console.log(`[demo] transcript sent: ${speaker}: ${text}`);
  await sleep(1000);
}

if (keepAlive) {
  console.log("[demo] --keep-alive: stub stays up; Ctrl-C to exit");
} else {
  const stopped = await postWebhook({
    event: "meeting.rtms_stopped",
    event_ts: Date.now(),
    payload: { meeting_uuid: MEETING_UUID, rtms_stream_id: STREAM_ID, stop_reason: 1 },
  });
  console.log("[demo] rtms_stopped webhook:", stopped.status, await stopped.text());
  await sleep(500);
  for (const server of [signalingServer, mediaServer]) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
  console.log("[demo] done");
  process.exit(0);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSourceState } from "@specstorming/shared";
import { ZoomRtmsClient } from "./ZoomRtmsClient.ts";
import { MSG_TYPE } from "./protocol.ts";
import { handleRtmsEvent } from "./dispatch.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeClient() {
  const chunks: { speaker: string; text: string; ts?: string }[] = [];
  const statuses: { state: LiveSourceState; detail?: string }[] = [];
  const client = new ZoomRtmsClient({
    credentials: { clientId: "cid", clientSecret: "csecret" },
    sink: (c) => chunks.push(c),
    status: (state, detail) => statuses.push({ state, detail }),
    allowInsecureUrls: true, // stub servers are ws://127.0.0.1
    log: silentLog,
  });
  return { client, chunks, statuses };
}

test("transcript message maps to a chunk with speaker, text, and ISO ts", () => {
  const { client, chunks } = makeClient();
  client.handleMediaMessage({
    msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
    content: "Payment failures spike on Mondays",
    user_name: "Maya",
    user_id: "u1",
    timestamp: 1754130000000,
  });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    speaker: "Maya",
    text: "Payment failures spike on Mondays",
    ts: new Date(1754130000000).toISOString(),
  });
});

test("non-transcript and empty messages are ignored", () => {
  const { client, chunks } = makeClient();
  client.handleMediaMessage({ msg_type: MSG_TYPE.KEEP_ALIVE_REQ, timestamp: 1 });
  client.handleMediaMessage({ msg_type: 99, content: "not transcript" });
  client.handleMediaMessage({ msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT, content: "   ", user_name: "Maya", timestamp: 2 });
  assert.equal(chunks.length, 0);
});

test("missing user_name falls back to Zoom", () => {
  const { client, chunks } = makeClient();
  client.handleMediaMessage({ msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT, content: "hello", timestamp: 3 });
  assert.equal(chunks[0]?.speaker, "Zoom");
});

test("re-delivered identical message (same speaker/text, ts not newer) is dropped", () => {
  const { client, chunks } = makeClient();
  const msg = {
    msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
    content: "Refunds go through finance",
    user_name: "Sam",
    timestamp: 1754130001000,
  };
  client.handleMediaMessage(msg);
  client.handleMediaMessage({ ...msg }); // exact re-delivery after reconnect
  client.handleMediaMessage({ ...msg, timestamp: 1754130000500 }); // older duplicate
  assert.equal(chunks.length, 1);
});

test("same text later, or new text at same ts, is still ingested", () => {
  const { client, chunks } = makeClient();
  client.handleMediaMessage({
    msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
    content: "yes",
    user_name: "Sam",
    timestamp: 1000,
  });
  // Same speaker says the same thing again, later — a real utterance.
  client.handleMediaMessage({
    msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
    content: "yes",
    user_name: "Sam",
    timestamp: 2000,
  });
  // Different text at the old timestamp — not a duplicate of the last message.
  client.handleMediaMessage({
    msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT,
    content: "no, wait",
    user_name: "Sam",
    timestamp: 2000,
  });
  assert.equal(chunks.length, 3);
});

test("duplicate tracking is per speaker", () => {
  const { client, chunks } = makeClient();
  client.handleMediaMessage({ msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT, content: "same words", user_name: "A", timestamp: 5000 });
  client.handleMediaMessage({ msg_type: MSG_TYPE.MEDIA_DATA_TRANSCRIPT, content: "same words", user_name: "B", timestamp: 5000 });
  assert.equal(chunks.length, 2);
});

test("a non-Zoom signaling url is refused when the allowlist is enforced (SSRF guard)", () => {
  const chunks: { speaker: string; text: string; ts?: string }[] = [];
  const statuses: { state: LiveSourceState; detail?: string }[] = [];
  const client = new ZoomRtmsClient({
    credentials: { clientId: "cid", clientSecret: "csecret" },
    sink: (c) => chunks.push(c),
    status: (state, detail) => statuses.push({ state, detail }),
    // allowInsecureUrls omitted → enforce wss://*.zoom.us
    log: silentLog,
  });
  client.start({ meetingUuid: "m", streamId: "s", serverUrl: "ws://127.0.0.1:1/internal" });
  assert.deepEqual(statuses.at(-1), { state: "disconnected", detail: "refused non-Zoom signaling url" });
  client.stop();
});

// ---- dispatch (webhook → client) exclusion rules ---------------------------

const startedEvent = {
  event: "meeting.rtms_started",
  payload: { meeting_uuid: "m1", rtms_stream_id: "s1", server_urls: "ws://127.0.0.1:1" },
};

test("rtms_started is ignored when the integration is disabled", () => {
  const { client, statuses } = makeClient();
  handleRtmsEvent("meeting.rtms_started", startedEvent, {
    enabled: false,
    replayRunning: () => false,
    client,
    status: (state, detail) => statuses.push({ state, detail }),
    log: silentLog,
  });
  assert.equal(client.active, false);
  assert.equal(statuses.length, 0);
});

test("rtms_started is refused with a status detail while replay is running", () => {
  const { client, statuses } = makeClient();
  handleRtmsEvent("meeting.rtms_started", startedEvent, {
    enabled: true,
    replayRunning: () => true,
    client,
    status: (state, detail) => statuses.push({ state, detail }),
    log: silentLog,
  });
  assert.equal(client.active, false);
  assert.deepEqual(statuses.at(-1), { state: "off", detail: "live source refused: replay is active" });
});

test("rtms_started with nested payload.object shape still starts the client", () => {
  const { client, statuses } = makeClient();
  handleRtmsEvent(
    "meeting.rtms_started",
    { event: "meeting.rtms_started", payload: { object: startedEvent.payload } },
    {
      enabled: true,
      replayRunning: () => false,
      client,
      status: (state, detail) => statuses.push({ state, detail }),
      log: silentLog,
    },
  );
  assert.equal(client.active, true);
  assert.equal(statuses.at(0)?.state, "waiting");
  client.stop();
});

test("rtms_stopped for the active stream tears the client down", () => {
  const { client } = makeClient();
  handleRtmsEvent("meeting.rtms_started", startedEvent, {
    enabled: true,
    replayRunning: () => false,
    client,
    status: () => {},
    log: silentLog,
  });
  assert.equal(client.active, true);
  handleRtmsEvent(
    "meeting.rtms_stopped",
    { event: "meeting.rtms_stopped", payload: { meeting_uuid: "m1", rtms_stream_id: "s1", stop_reason: 1 } },
    { enabled: true, replayRunning: () => false, client, status: () => {}, log: silentLog },
  );
  assert.equal(client.active, false);
});

test("rtms_stopped for a different stream is ignored", () => {
  const { client } = makeClient();
  handleRtmsEvent("meeting.rtms_started", startedEvent, {
    enabled: true,
    replayRunning: () => false,
    client,
    status: () => {},
    log: silentLog,
  });
  handleRtmsEvent(
    "meeting.rtms_stopped",
    { event: "meeting.rtms_stopped", payload: { rtms_stream_id: "other" } },
    { enabled: true, replayRunning: () => false, client, status: () => {}, log: silentLog },
  );
  assert.equal(client.active, true);
  client.stop();
});

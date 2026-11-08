/**
 * Protects the CLIENT_READY_ACK check of ss-js5 where rtms.latency.e2e.test.ts cannot. That test
 * runs the shared lifecycle check in rtmsStub.ts, which is not protected, so emptying the check
 * there passed every protected case. This file asserts the ack and its stream id itself, with its
 * own poll, so no edit to rtmsStub.ts's checks or to its waitFor can weaken it. It still needs the
 * stub to record what the client sends; a stub that stops recording fails it rather than passes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSourceState } from "@specstorming/shared";
import { ZoomRtmsClient } from "./ZoomRtmsClient.ts";
import { MSG_TYPE } from "./protocol.ts";
import { CREDS, STREAM, silentLog, startStub } from "./rtmsStub.ts";

/** Polls every 10 ms, and rejects once `timeoutMs` passes without the condition. */
function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

for (const [label, signalingLatencyMs] of [
  ["a stub that answers at once", 0],
  ["a stub with a slow signaling link", 100],
] as const) {
  test(`the client sends CLIENT_READY_ACK with its stream id, to ${label}`, async () => {
    const stub = await startStub({ signalingLatencyMs });
    const statuses: LiveSourceState[] = [];
    const client = new ZoomRtmsClient({
      credentials: CREDS,
      sink: () => {},
      status: (state) => statuses.push(state),
      allowInsecureUrls: true,
      log: silentLog,
    });
    const readyAck = () => stub.received.signaling.find((m) => m.msg_type === MSG_TYPE.CLIENT_READY_ACK);

    try {
      client.start({ ...STREAM, serverUrl: stub.serverUrl });
      await until(() => statuses.includes("connected"), 'the client to report "connected"');
      await until(() => readyAck() !== undefined, "CLIENT_READY_ACK on the signaling socket");
      const ack = readyAck();
      assert.ok(ack, "CLIENT_READY_ACK sent on signaling socket");
      assert.equal(ack.rtms_stream_id, STREAM.streamId);
    } finally {
      client.stop();
      await stub.close();
    }
  });
}

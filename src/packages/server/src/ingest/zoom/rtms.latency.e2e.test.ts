/**
 * Reproduces ss-js5. The client reports "connected" in the same handler that sends
 * CLIENT_READY_ACK, so the stub reads the ack only in a later event-loop turn. The full-lifecycle
 * check read the stub's record as soon as it saw "connected", and failed whenever its poll fell in
 * that gap. A stub that handles each signaling message late forces the gap on every run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSourceState } from "@specstorming/shared";
import { ZoomRtmsClient } from "./ZoomRtmsClient.ts";
import { MSG_TYPE } from "./protocol.ts";
import { CREDS, STREAM, runFullLifecycle, silentLog, startStub, waitFor } from "./rtmsStub.ts";

/** Ten times waitFor's 10 ms poll, so the poll sees "connected" before the stub reads the ack. */
const SIGNALING_LATENCY_MS = 100;

// Guard case: without the gap, the next test would pass without exercising the race.
test("a slow signaling stub reads CLIENT_READY_ACK only after the client reports connected", async () => {
  const stub = await startStub({ signalingLatencyMs: SIGNALING_LATENCY_MS });
  const statuses: LiveSourceState[] = [];
  const client = new ZoomRtmsClient({
    credentials: CREDS,
    sink: () => {},
    status: (state) => statuses.push(state),
    allowInsecureUrls: true,
    log: silentLog,
  });
  const hasReadyAck = () => stub.received.signaling.some((m) => m.msg_type === MSG_TYPE.CLIENT_READY_ACK);

  try {
    client.start({ ...STREAM, serverUrl: stub.serverUrl });
    await waitFor(() => statuses.includes("connected"));
    assert.equal(hasReadyAck(), false, "the stub has not read CLIENT_READY_ACK when the client reports connected");
    await waitFor(hasReadyAck);
  } finally {
    client.stop();
    await stub.close();
  }
});

test("full lifecycle against a stub RTMS backend with a slow signaling link", async () => {
  const stub = await startStub({ signalingLatencyMs: SIGNALING_LATENCY_MS });
  try {
    await runFullLifecycle(stub);
  } finally {
    await stub.close();
  }
});

import { test } from "node:test";
import type { LiveSourceState } from "@specstorming/shared";
import { ZoomRtmsClient } from "./ZoomRtmsClient.ts";
import { CREDS, STREAM, runFullLifecycle, silentLog, startStub, waitFor } from "./rtmsStub.ts";

test("full lifecycle against a stub RTMS backend", async () => {
  const stub = await startStub();
  try {
    await runFullLifecycle(stub);
  } finally {
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

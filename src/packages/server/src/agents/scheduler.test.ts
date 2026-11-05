import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { AgentScheduler, type AgentIdentity } from "./scheduler.ts";

/** A job that records enter/exit into `log` and resolves when we tell it to. */
function controlledJob(log: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = async () => {
    log.push(`start:${name}`);
    await gate;
    log.push(`end:${name}`);
    return name;
  };
  return { run, release };
}

test("single-flight: overlapping jobs never interleave", async () => {
  const s = new AgentScheduler();
  const log: string[] = [];
  const a = controlledJob(log, "a");
  const b = controlledJob(log, "b");

  const pa = s.schedule("synthesizer", a.run);
  const pb = s.schedule("synthesizer", b.run);
  await Promise.resolve(); // let pump start job a
  strictEqual(s.busy(), true);

  a.release();
  b.release();
  await Promise.all([pa, pb]);

  deepStrictEqual(log, ["start:a", "end:a", "start:b", "end:b"]);
  strictEqual(s.busy(), false);
});

test("priority: pending work drains synthesizer → coach → pipeline → assessment → hints", async () => {
  const s = new AgentScheduler();
  const order: string[] = [];
  const first = controlledJob(order, "running-synth");

  const p1 = s.schedule("synthesizer", first.run);
  await Promise.resolve(); // first job is now executing
  const enqueue = (agent: AgentIdentity, name: string) =>
    s.schedule(agent, async () => {
      order.push(name);
      return name;
    });
  // Enqueued in reverse priority order, so the drain order below proves priority rather than
  // insertion order.
  const rest = [
    enqueue("hints", "hint"),
    enqueue("assessment", "assessment"),
    enqueue("pipeline", "pipeline"),
    enqueue("coach", "coach"),
    enqueue("synthesizer", "synth2"),
  ];

  first.release();
  await Promise.all([p1, ...rest]);

  deepStrictEqual(order, [
    "start:running-synth",
    "end:running-synth",
    "synth2",
    "coach",
    "pipeline",
    "assessment",
    "hint",
  ]);
});

test("FIFO within a priority class", async () => {
  const s = new AgentScheduler();
  const order: string[] = [];
  const first = controlledJob(order, "gate");
  const p1 = s.schedule("coach", first.run);
  await Promise.resolve();
  const p2 = s.schedule("coach", async () => order.push("coach-1"));
  const p3 = s.schedule("coach", async () => order.push("coach-2"));
  first.release();
  await Promise.all([p1, p2, p3]);
  deepStrictEqual(order, ["start:gate", "end:gate", "coach-1", "coach-2"]);
});

test("replaceKey: a newer job replaces the pending one, which resolves undefined", async () => {
  const s = new AgentScheduler();
  const ran: string[] = [];
  const first = controlledJob(ran, "gate");
  const p1 = s.schedule("synthesizer", first.run);
  await Promise.resolve();
  const stale = s.schedule("hints", async () => ran.push("stale"), { replaceKey: "hints" });
  const fresh = s.schedule("hints", async () => ran.push("fresh"), { replaceKey: "hints" });
  first.release();
  const [, staleResult] = await Promise.all([p1, stale, fresh]);
  strictEqual(staleResult, undefined);
  deepStrictEqual(ran, ["start:gate", "end:gate", "fresh"]);
});

test("lifecycle: queued/running/done transitions, failed on rejection and soft outcome", async () => {
  const s = new AgentScheduler();
  const events: string[] = [];
  s.onLifecycle = (e) => events.push(`${e.agent}:${e.state}${e.detail ? `:${e.detail}` : ""}`);

  await s.schedule("coach", async () => "ok");
  await s.schedule("hints", async () => {
    throw new Error("boom");
  }).catch(() => {});
  await s.schedule("synthesizer", async () => ({ isError: true }), {
    outcome: (v) => ((v as { isError: boolean }).isError ? { failed: true, detail: "timed out" } : { failed: false }),
  });

  deepStrictEqual(events, [
    "coach:queued",
    "coach:running",
    "coach:done",
    "hints:queued",
    "hints:running",
    "hints:failed:boom",
    "synthesizer:queued",
    "synthesizer:running",
    "synthesizer:failed:timed out",
  ]);
  deepStrictEqual(
    s.latestStatuses().map((e) => `${e.agent}:${e.state}`),
    ["coach:done", "hints:failed", "synthesizer:failed"],
  );
});

test("reset: queued jobs are dropped without running, and statuses are forgotten", async () => {
  const s = new AgentScheduler();
  const log: string[] = [];
  const active = controlledJob(log, "active");

  // One job executing, two queued behind it.
  const pActive = s.schedule("synthesizer", active.run);
  const pQueuedA = s.schedule("hints", async () => {
    log.push("start:queuedA");
    return "queuedA";
  });
  const pQueuedB = s.schedule("coach", async () => {
    log.push("start:queuedB");
    return "queuedB";
  });

  s.reset();

  // Dropped jobs settle immediately as undefined — the replaceKey contract — so no caller hangs.
  strictEqual(await pQueuedA, undefined);
  strictEqual(await pQueuedB, undefined);
  deepStrictEqual(s.latestStatuses(), [], "stale chips must not survive a reset");

  // The already-executing job is left alone and still completes normally.
  active.release();
  strictEqual(await pActive, "active");

  deepStrictEqual(
    log,
    ["start:active", "end:active"],
    "a job queued against the old session must never run against the new one",
  );
});

/**
 * Pipeline reset. Two things have to hold.
 *
 * 1. The produced specs outlive SessionState — /api/stream replays getState().artifacts to every
 *    newly connected client — so a session reset has to clear them or the previous session's
 *    specs reappear on a browser refresh, and an abandoned run must not write into the fresh
 *    session either. Those tests drive the private write helpers directly (where the runId guard
 *    lives), keeping the SDK out of the test — the same approach quiesce.test.ts takes.
 * 2. An abandoned run must actually STOP. It used to keep executing, and since the
 *    AgentScheduler serializes jobs rather than runs, the orphan's remaining steps interleaved
 *    one-for-one with the new run's — putting Phase 3 of one run ahead of Phase 2 of another.
 *    Those tests drive run() end to end with injected fake steps.
 */

import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import type { ServerEvent, SpecArtifact } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import { PipelineRunner, type PipelineSteps } from "./orchestrator.ts";

/** The private write helpers the runId guard protects. */
type Writes = {
  setStage(runId: number, stage: string, detail?: string): void;
  addArtifact(runId: number, artifact: SpecArtifact): void;
};

function spec(id: string): SpecArtifact {
  return {
    id,
    kind: "bounded-context",
    title: `Spec ${id}`,
    markdown: "# spec",
    createdAt: new Date(0).toISOString(),
  };
}

function harness(steps: Partial<PipelineSteps> = {}) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new PipelineRunner(new SessionMemory(bus), bus, steps);
  return { pipeline, events, writes: pipeline as unknown as Writes };
}

/** A stage that never resolves on its own — the test decides when (and whether) it finishes. */
function gatedStep(name: string, calls: { name: string; signal?: AbortSignal }[]) {
  let release!: (value: SpecArtifact) => void;
  const gate = new Promise<SpecArtifact>((resolve) => {
    release = resolve;
  });
  const step = async (_input: unknown, signal?: AbortSignal): Promise<SpecArtifact> => {
    calls.push({ name, signal });
    return gate;
  };
  return { step, release: () => release(spec(name)) };
}

test("reset clears produced specs and returns the stage to idle", () => {
  const { pipeline, events, writes } = harness();

  writes.addArtifact(0, spec("a"));
  writes.setStage(0, "done");
  strictEqual(pipeline.getState().artifacts.length, 1);

  pipeline.reset();

  const state = pipeline.getState();
  strictEqual(state.stage, "idle");
  deepStrictEqual(state.artifacts, []);
  // Already-connected clients need telling too, not just the ones that connect later.
  strictEqual(events.some((e) => e.type === "pipeline.status" && e.stage === "idle"), true);
});

test("a run abandoned by reset cannot write into the fresh session", () => {
  const { pipeline, writes } = harness();

  // A run in flight captured runId 0 before the reset.
  pipeline.reset();

  writes.addArtifact(0, spec("stale"));
  writes.setStage(0, "done");

  const state = pipeline.getState();
  deepStrictEqual(state.artifacts, [], "the abandoned run's specs must not land");
  strictEqual(state.stage, "idle", "the abandoned run must not move the stage off idle");
});

test("a run started after the reset writes normally", () => {
  const { pipeline, writes } = harness();

  pipeline.reset();
  const current = 1; // runId after one reset

  writes.addArtifact(current, spec("fresh"));
  writes.setStage(current, "done");

  const state = pipeline.getState();
  strictEqual(state.artifacts.length, 1);
  strictEqual(state.artifacts[0].id, "fresh");
  strictEqual(state.stage, "done");
});

test("reset aborts the in-flight step and stops the run before its next stage", async () => {
  const calls: { name: string; signal?: AbortSignal }[] = [];
  const bc = gatedStep("bc", calls);
  const arch = gatedStep("arch", calls);
  const nego = gatedStep("nego", calls);
  const { pipeline, events } = harness({
    boundaryAnalyzer: bc.step,
    solutionArchitect: arch.step,
    negotiation: nego.step,
  });

  const run = pipeline.run();
  await Promise.resolve(); // let the first step start
  strictEqual(calls.length, 1, "only the first stage should have started");
  strictEqual(calls[0].signal?.aborted, false);

  pipeline.reset();

  // The executing step sees the abort immediately; the real steps translate that into a
  // cancelled agent result, so simulate it resolving afterwards.
  strictEqual(calls[0].signal?.aborted, true, "reset must abort the running step");
  bc.release();
  strictEqual(await run, false, "an abandoned run does not report success");

  strictEqual(calls.length, 1, "no further stage may be started after reset");
  strictEqual(
    events.some((e) => e.type === "pipeline.status" && e.stage === "error"),
    false,
    "a deliberate cancellation is not a pipeline error",
  );
  deepStrictEqual(pipeline.getState().artifacts, []);
  strictEqual(pipeline.getState().stage, "idle");
});

test("a run started after a reset gets a fresh signal and completes", async () => {
  const calls: { name: string; signal?: AbortSignal }[] = [];
  const bc = gatedStep("bc", calls);
  const arch = gatedStep("arch", calls);
  const nego = gatedStep("nego", calls);
  const { pipeline } = harness({
    boundaryAnalyzer: bc.step,
    solutionArchitect: arch.step,
    negotiation: nego.step,
  });

  pipeline.reset();
  const run = pipeline.run();
  await Promise.resolve();
  bc.release();
  await Promise.resolve();
  arch.release();
  await Promise.resolve();
  nego.release();

  strictEqual(await run, true);
  strictEqual(calls.length, 3, "all three stages run, in order");
  deepStrictEqual(
    calls.map((c) => c.name),
    ["bc", "arch", "nego"],
  );
  strictEqual(
    calls.every((c) => c.signal?.aborted === false),
    true,
    "the new run must not inherit the previous run's aborted signal",
  );
  strictEqual(pipeline.getState().artifacts.length, 3);
  strictEqual(pipeline.getState().stage, "done");
});

test("run() refuses to start a second run while one is in flight", async () => {
  const calls: { name: string; signal?: AbortSignal }[] = [];
  const bc = gatedStep("bc", calls);
  const { pipeline } = harness({ boundaryAnalyzer: bc.step });

  const first = pipeline.run();
  await Promise.resolve();
  strictEqual(pipeline.isRunning(), true);
  strictEqual(await pipeline.run(), false, "the concurrent request must be rejected, not queued");
  strictEqual(calls.length, 1, "the rejected request must not start a second Phase 2");

  pipeline.reset();
  bc.release();
  await first;
});

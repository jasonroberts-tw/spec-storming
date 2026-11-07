/**
 * Background quiescence: starting the spec pipeline must stop agents *starting* new work,
 * while leaving anything in flight alone. These tests drive the private run entry points
 * directly — that is where the guards live, and it keeps the SDK out of the test.
 */

import { strictEqual } from "node:assert";
import { test } from "node:test";
import type { SessionState, Sticky, TranscriptChunk } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import { CoachAgent } from "./CoachAgent.ts";
import { HintAgent } from "./HintAgent.ts";
import { SynthesizerAgent } from "./SynthesizerAgent.ts";

/** The private run entry points the suspend guards protect. */
type RunOnce = { runOnce(): Promise<void> };
/** CoachAgent arms exactly one timer; its nullness is the observable gate state. */
type Armed = { assessmentTimer: ReturnType<typeof setTimeout> | null };

function seeded(chunks: number): { bus: EventBus; memory: SessionMemory } {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  for (let i = 0; i < chunks; i++) {
    memory.appendChunk({ speaker: "Dev-Anya", text: `line ${i}` });
  }
  return { bus, memory };
}

// ---- SynthesizerAgent -------------------------------------------------------

test("synthesizer: runOnce is a no-op while suspended (closes the finally re-arm hole)", (t) => {
  const { bus, memory } = seeded(3);
  const agent = new SynthesizerAgent(memory, bus);
  const backlog = t.mock.method(memory, "unprocessedSince", () => [] as TranscriptChunk[]);

  agent.suspend();
  void (agent as unknown as RunOnce).runOnce();

  // Reaching the backlog read means a new batch would have started.
  strictEqual(backlog.mock.callCount(), 0);
});

test("synthesizer: suspend preserves the backlog watermark, suspendCaughtUp discards it", (t) => {
  const preserved = seeded(3);
  const a = new SynthesizerAgent(preserved.memory, preserved.bus);
  const aBacklog = t.mock.method(preserved.memory, "unprocessedSince", () => [] as TranscriptChunk[]);
  a.suspend();
  a.resume();
  void (a as unknown as RunOnce).runOnce();
  strictEqual(aBacklog.mock.callCount(), 1);
  strictEqual(aBacklog.mock.calls[0].arguments[0], 0, "suspend must not advance lastProcessedSeq");

  const discarded = seeded(3);
  const b = new SynthesizerAgent(discarded.memory, discarded.bus);
  const bBacklog = t.mock.method(discarded.memory, "unprocessedSince", () => [] as TranscriptChunk[]);
  b.suspendCaughtUp();
  b.resume();
  void (b as unknown as RunOnce).runOnce();
  strictEqual(bBacklog.mock.callCount(), 1);
  strictEqual(bBacklog.mock.calls[0].arguments[0], 3, "suspendCaughtUp jumps to the tail");
});

// ---- HintAgent --------------------------------------------------------------

test("hints: runOnce is a no-op while suspended, and reachable once resumed", (t) => {
  const { bus, memory } = seeded(5);
  const agent = new HintAgent(memory, bus);
  const read = t.mock.method(memory, "getState");

  agent.suspend();
  void (agent as unknown as RunOnce).runOnce();
  strictEqual(read.mock.callCount(), 0);

  // Resumed, shouldRun() reads state and then bails at the cold-start canvas gate — no SDK.
  agent.resume();
  void (agent as unknown as RunOnce).runOnce();
  strictEqual(read.mock.callCount(), 1);
});

// ---- CoachAgent proactive assessment ---------------------------------------

function sticky(id: string, kind: Sticky["kind"], order: number): Sticky {
  return {
    id,
    kind,
    text: id.replaceAll("-", " "),
    confidence: "high",
    sourceChunkIds: [`source-${id}`],
    order,
    createdAtRev: 1,
    updatedAtRev: 1,
  };
}

/** scheduleAssessment bails on an empty canvas, so the gate needs a non-empty one to be visible. */
function assessableState(): SessionState {
  const state = emptySession("demo", "Quiesce");
  state.canvas.stickies = [
    sticky("place-order", "command", 1),
    sticky("order-placed", "domainEvent", 2),
  ];
  state.canvas.lastUpdatedRev = 1;
  state.revision = 1;
  state.transcript = [{ id: "t-0001", ts: new Date(0).toISOString(), speaker: "PO-Sam", text: "hi", seq: 1 }];
  return state;
}

test("coach: suspendAssessments stops new reviews arming; ask() and resume are unaffected", (t) => {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  memory.hydrate(assessableState());
  const coach = new CoachAgent(memory, bus);
  t.after(() => coach.stop());

  const chunk: TranscriptChunk = {
    id: "t-0002",
    ts: new Date(0).toISOString(),
    speaker: "Dev-Anya",
    text: "next",
    seq: 2,
  };
  const armed = () => (coach as unknown as Armed).assessmentTimer !== null;

  coach.start();
  strictEqual(armed(), true, "a live session arms a review");

  coach.suspendAssessments();
  strictEqual(armed(), false, "suspending cancels the pending review");
  bus.emit({ type: "transcript.chunk", chunk });
  bus.emit({ type: "canvas.updated", canvas: memory.getState().canvas, revision: 2 });
  strictEqual(armed(), false, "no trigger re-arms while suspended");

  coach.resumeAssessments();
  bus.emit({ type: "transcript.chunk", chunk });
  strictEqual(armed(), true, "resuming restores the normal cadence");
});

test("coach: reset clears the suspended flag so a fresh session is reviewed", (t) => {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  memory.hydrate(assessableState());
  const coach = new CoachAgent(memory, bus);
  t.after(() => coach.stop());

  coach.start();
  coach.suspendAssessments();
  coach.reset();
  bus.emit({ type: "transcript.chunk", chunk: { id: "t-0003", ts: new Date(0).toISOString(), speaker: "PO-Sam", text: "again", seq: 3 } });

  strictEqual((coach as unknown as Armed).assessmentTimer !== null, true);
});

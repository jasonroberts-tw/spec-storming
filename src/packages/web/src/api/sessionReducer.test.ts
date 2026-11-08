import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ChatMessage,
  Hint,
  ServerEvent,
  SpecArtifact,
  TranscriptChunk,
} from "@specstorming/shared";
import { emptyCanvas } from "@specstorming/shared";
import type { SessionView } from "./sessionReducer.ts";
import { initialView, mergeChat, reducer } from "./sessionReducer.ts";

/** Freezes a value and everything it holds, so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** A frozen view: the initial one with `over` laid on top. */
const view = (over: Partial<SessionView> = {}): SessionView => deepFreeze({ ...initialView, ...over });

/** Folds `events` into `state` in order, freezing each state the reducer is handed. */
const apply = (state: SessionView, ...events: ServerEvent[]): SessionView =>
  events.reduce((s, event) => reducer(deepFreeze(s), { type: "event", event }), state);

const chunk = (seq: number): TranscriptChunk => ({
  id: `t-${seq}`,
  ts: `2026-11-08T10:00:0${seq}.000Z`,
  speaker: "Facilitator",
  text: `line ${seq}`,
  seq,
});

const hint = (id: string): Hint => ({
  id,
  kind: "go-deeper",
  text: `hint ${id}`,
  prompt: `prompt ${id}`,
  status: "active",
  createdTs: "2026-11-08T10:00:00.000Z",
});

const spec = (id: string, title = id): SpecArtifact => ({
  id,
  kind: "bounded-context",
  title,
  markdown: `# ${title}`,
  createdAt: "2026-11-08T10:00:00.000Z",
});

const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "coach",
  text: `text of ${id}`,
  ts: "2026-11-08T10:00:00.000Z",
  ...over,
});

describe("reducer: local actions", () => {
  test("connected sets the connection flag, both ways", () => {
    const up = reducer(view(), { type: "connected", value: true });
    assert.equal(up.connected, true);
    assert.equal(reducer(deepFreeze(up), { type: "connected", value: false }).connected, false);
  });

  test("coach.begin raises the pending flag and clears the last error", () => {
    const next = reducer(view({ coachError: "The coach couldn't reply." }), { type: "coach.begin" });
    assert.equal(next.coachPending, true);
    assert.equal(next.coachError, undefined);
  });
});

describe("reducer: server events", () => {
  test("transcript.chunk appends each chunk in arrival order", () => {
    const next = apply(view(), { type: "transcript.chunk", chunk: chunk(1) }, { type: "transcript.chunk", chunk: chunk(2) });
    assert.deepEqual(next.transcript, [chunk(1), chunk(2)]);
  });

  test("canvas.updated replaces the canvas and the revision", () => {
    const canvas = { ...emptyCanvas(), lastUpdatedRev: 7 };
    const next = apply(view({ revision: 3 }), { type: "canvas.updated", canvas, revision: 7 });
    assert.deepEqual(next.canvas, canvas);
    assert.equal(next.revision, 7);
  });

  test("hints.updated replaces the hints instead of appending to them", () => {
    const next = apply(view({ hints: [hint("old")] }), { type: "hints.updated", hints: [hint("a"), hint("b")] });
    assert.deepEqual(next.hints, [hint("a"), hint("b")]);
  });

  test("agent.status records each agent's state and detail, and keeps the other agents'", () => {
    const next = apply(
      view({ agents: { synthesizer: { state: "running" } } }),
      { type: "agent.status", agent: "hints", state: "queued", detail: "behind synthesis" },
    );
    assert.deepEqual(next.agents, {
      synthesizer: { state: "running" },
      hints: { state: "queued", detail: "behind synthesis" },
    });
  });

  test("agent.status for a failed coach run ends the wait and names the detail", () => {
    const next = apply(view({ coachPending: true }), { type: "agent.status", agent: "coach", state: "failed", detail: "rate limited" });
    assert.equal(next.coachPending, false);
    assert.equal(next.coachError, "The coach couldn't reply (rate limited).");
    assert.deepEqual(next.agents.coach, { state: "failed", detail: "rate limited" });
  });

  test("agent.status for a failed coach run with no detail ends the wait with the plain error", () => {
    const next = apply(view({ coachPending: true }), { type: "agent.status", agent: "coach", state: "failed" });
    assert.equal(next.coachPending, false);
    assert.equal(next.coachError, "The coach couldn't reply.");
  });

  test("agent.status for a failed assessment leaves the chat's wait and error alone", () => {
    const next = apply(view({ coachPending: true }), { type: "agent.status", agent: "assessment", state: "failed", detail: "timeout" });
    assert.equal(next.coachPending, true);
    assert.equal(next.coachError, undefined);
    assert.deepEqual(next.agents.assessment, { state: "failed", detail: "timeout" });
  });

  test("agent.status for a coach run that has not failed leaves the chat's wait alone", () => {
    const next = apply(view({ coachPending: true }), { type: "agent.status", agent: "coach", state: "running" });
    assert.equal(next.coachPending, true);
    assert.equal(next.coachError, undefined);
  });

  test("session.status sets the session's status", () => {
    assert.equal(apply(view(), { type: "session.status", status: "finished" }).status, "finished");
  });

  test("live.status replaces the live source's state and detail", () => {
    const next = apply(
      view({ liveSource: { state: "waiting", detail: "old" } }),
      { type: "live.status", state: "connected" },
    );
    assert.deepEqual(next.liveSource, { state: "connected", detail: undefined });
  });

  test("pipeline.status sets the stage and its detail", () => {
    const next = apply(view(), { type: "pipeline.status", stage: "architecture", detail: "2 of 3" });
    assert.equal(next.pipelineStage, "architecture");
    assert.equal(next.pipelineDetail, "2 of 3");
  });

  test("spec.produced appends an artifact it has not seen", () => {
    const next = apply(view({ specs: [spec("a")] }), { type: "spec.produced", artifact: spec("b") });
    assert.deepEqual(next.specs, [spec("a"), spec("b")]);
  });

  test("spec.produced for an id it holds returns the same state, and keeps the first artifact", () => {
    const state = view({ specs: [spec("a", "first")] });
    const next = reducer(state, { type: "event", event: { type: "spec.produced", artifact: spec("a", "second") } });
    assert.equal(next, state);
  });

  test("coach.delta for a new message appends it, stamped now, and ends the wait", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T12:34:56.000Z") });
    const next = apply(view({ coachPending: true }), {
      type: "coach.delta",
      messageId: "m1",
      text: "Hel",
      kind: "conversation",
      canvasRevision: 4,
    });
    assert.equal(next.coachPending, false);
    assert.deepEqual(next.coachChat, [
      { id: "m1", role: "coach", text: "Hel", ts: "2026-11-08T12:34:56.000Z", kind: "conversation", canvasRevision: 4 },
    ]);
  });

  test("coach.delta for a new message with no kind ends the wait too", () => {
    const next = apply(view({ coachPending: true }), { type: "coach.delta", messageId: "m1", text: "Hi" });
    assert.equal(next.coachPending, false);
    assert.equal(next.coachChat.length, 1);
  });

  test("coach.delta for a new assessment leaves the chat's wait alone", () => {
    const next = apply(view({ coachPending: true }), {
      type: "coach.delta",
      messageId: "assessment-4-x",
      text: "{",
      kind: "assessment",
      canvasRevision: 4,
    });
    assert.equal(next.coachPending, true);
    assert.equal(next.coachChat[0].kind, "assessment");
  });

  test("coach.delta for an existing message appends its text, and touches nothing else", () => {
    const first = message("m1", { text: "Hel" });
    const other = message("m2", { text: "other" });
    const next = apply(view({ coachChat: [first, other], coachPending: true }), {
      type: "coach.delta",
      messageId: "m1",
      text: "lo",
      kind: "conversation",
    });
    assert.deepEqual(next.coachChat, [{ ...first, text: "Hello" }, other]);
    assert.equal(next.coachPending, true);
  });

  test("coach.done replaces the streamed message with the final one", () => {
    const final = message("m1", { text: "Hello there", kind: "conversation" });
    const next = apply(view({ coachChat: [message("m0"), message("m1", { text: "Hel" })] }), { type: "coach.done", message: final });
    assert.deepEqual(next.coachChat, [message("m0"), final]);
  });

  test("coach.done for a message it has not seen appends it, and ends the wait", () => {
    const final = message("m1", { kind: "conversation" });
    const next = apply(view({ coachChat: [message("m0")], coachPending: true }), { type: "coach.done", message: final });
    assert.deepEqual(next.coachChat, [message("m0"), final]);
    assert.equal(next.coachPending, false);
  });

  test("coach.done for an assessment leaves the chat's wait alone", () => {
    const next = apply(view({ coachPending: true }), { type: "coach.done", message: message("assessment-4-x", { kind: "assessment" }) });
    assert.equal(next.coachPending, true);
  });

  test("session.reset drops everything the session held, and keeps the connection flag", () => {
    const loaded = view({
      connected: true,
      transcript: [chunk(1)],
      canvas: { ...emptyCanvas(), lastUpdatedRev: 9 },
      revision: 9,
      coachChat: [message("m1")],
      hints: [hint("a")],
      agents: { coach: { state: "done" } },
      coachPending: true,
      coachError: "The coach couldn't reply.",
      status: "finished",
      liveSource: { state: "connected" },
      pipelineStage: "done",
      pipelineDetail: "finished",
      specs: [spec("a")],
    });
    assert.deepEqual(apply(loaded, { type: "session.reset" }), { ...initialView, connected: true });
    assert.deepEqual(apply(view({ connected: false, revision: 9 }), { type: "session.reset" }), { ...initialView, connected: false });
  });

  test("an event the reducer does not handle returns the same state", () => {
    const state = view({ revision: 5, coachChat: [message("m1")] });
    const unhandled: ServerEvent[] = [
      { type: "hello", sessionId: "demo", revision: 6 },
      { type: "heartbeat", ts: "2026-11-08T10:00:00.000Z" },
      // A type a newer server might send, which this client has no case for.
      { type: "board.updated" } as unknown as ServerEvent,
    ];
    for (const event of unhandled) assert.equal(reducer(state, { type: "event", event }), state, event.type);
  });
});

describe("mergeChat", () => {
  test("keeps one message per id, and the local turn when both lists hold it", () => {
    const local = message("u1", { role: "user", text: "local copy", ts: "2026-11-08T10:00:01.000Z" });
    const server = message("u1", { role: "user", text: "server copy", ts: "2026-11-08T10:00:01.000Z" });
    assert.deepEqual(mergeChat([local], [server]), [local]);
  });

  test("drops a duplicate inside one list, keeping the first", () => {
    const first = message("m1", { text: "first" });
    assert.deepEqual(mergeChat([], [first, message("m1", { text: "second" })]), [first]);
  });

  test("sorts local and server messages together by timestamp", () => {
    const u1 = message("u1", { role: "user", ts: "2026-11-08T10:00:01.000Z" });
    const c1 = message("c1", { ts: "2026-11-08T10:00:02.000Z" });
    const u2 = message("u2", { role: "user", ts: "2026-11-08T10:00:03.000Z" });
    const c2 = message("c2", { ts: "2026-11-08T10:00:04.000Z" });
    assert.deepEqual(mergeChat(deepFreeze([u2, u1]), deepFreeze([c2, c1])), [u1, c1, u2, c2]);
  });

  test("keeps local before server for messages with the same timestamp", () => {
    const ts = "2026-11-08T10:00:01.000Z";
    const local = message("u1", { role: "user", ts });
    const server = message("c1", { ts });
    assert.deepEqual(mergeChat([local], [server]), [local, server]);
  });

  test("returns an empty chat for two empty lists", () => {
    assert.deepEqual(mergeChat([], []), []);
  });
});

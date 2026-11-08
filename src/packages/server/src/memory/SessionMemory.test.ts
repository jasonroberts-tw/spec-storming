import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionState } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { sessionContext } from "../agents/CoachAgent.ts";
import { EventBus } from "../bus/EventBus.ts";
import { SERVER_CONFIG } from "../config.ts";
import { createLayoutState } from "../mural/layout.ts";
import { SessionMemory } from "./SessionMemory.ts";
import type { SnapshotStore } from "./store.ts";

function countCanvasEvents(bus: EventBus): { count: () => number } {
  let n = 0;
  bus.subscribe((e) => {
    if (e.type === "canvas.updated") n += 1;
  });
  return { count: () => n };
}

test("applyCanvasBatch: N items emit exactly one canvas.updated and one revision bump", () => {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  const events = countCanvasEvents(bus);
  const revBefore = memory.revision;

  const applied = memory.applyCanvasBatch({
    stickies: [
      { id: "order-placed", kind: "domainEvent", text: "Order Placed" },
      { id: "place-order", kind: "command", text: "Place Order" },
      { id: "customer", kind: "actor", text: "Customer" },
    ],
    hotspots: [{ id: "h-refunds", text: "Refund flow disputed", sourceChunkIds: [] }],
  });

  strictEqual(applied, 4);
  strictEqual(events.count(), 1);
  strictEqual(memory.revision, revBefore + 1);
  strictEqual(memory.getState().canvas.stickies.length, 3);
});

test("single-item upsert outside a batch still broadcasts", () => {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  const events = countCanvasEvents(bus);
  memory.upsertSticky({ id: "one", kind: "domainEvent", text: "One Thing Happened" });
  strictEqual(events.count(), 1);
});

test("coach sessionContext stays flat as the transcript grows", () => {
  const short = emptySession("s", "t");
  for (let i = 0; i < 30; i++) {
    short.transcript.push({
      id: `t-${i}`,
      ts: "2026-08-01T00:00:00Z",
      speaker: "Alice",
      text: `line ${i} about orders and payments`,
      seq: i + 1,
    });
  }
  const long = structuredClone(short);
  for (let i = 30; i < 2000; i++) {
    long.transcript.push({
      id: `t-${i}`,
      ts: "2026-08-01T00:00:00Z",
      speaker: "Bob",
      text: `line ${i} about orders and payments`,
      seq: i + 1,
    });
  }

  const shortCtx = sessionContext(short);
  const longCtx = sessionContext(long);
  // The long session includes a one-line "N earlier lines omitted" note; allow slack for it
  // but the context must not grow with the transcript.
  ok(longCtx.length < shortCtx.length + 200, `grew: ${shortCtx.length} -> ${longCtx.length}`);
  ok(longCtx.includes("t-1999"), "includes the newest line");
  ok(!longCtx.includes("[t-10]"), "oldest lines are omitted");
});

// ---- snapshots ---------------------------------------------------------------

/** A store that keeps a copy of each state it is asked to save, and writes nothing. */
function recordingStore(): SnapshotStore & { saves: SessionState[] } {
  const saves: SessionState[] = [];
  return {
    saves,
    save: async (state) => {
      saves.push(structuredClone(state));
    },
    load: async () => null,
  };
}

test("snapshot: several changes inside 500 ms cause one save, which holds the latest state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = recordingStore();
  const memory = new SessionMemory(new EventBus(), { snapshots: store });

  memory.appendChunk({ speaker: "Ana", text: "one", ts: "2026-08-01T00:00:00Z" });
  t.mock.timers.tick(200);
  memory.appendChunk({ speaker: "Ana", text: "two", ts: "2026-08-01T00:00:01Z" });
  t.mock.timers.tick(200);
  memory.upsertSticky({ id: "order-placed", kind: "domainEvent", text: "Order Placed" });
  t.mock.timers.tick(99);
  strictEqual(store.saves.length, 0, "saved before 500 ms had passed");

  t.mock.timers.tick(1);
  strictEqual(store.saves.length, 1);
  deepStrictEqual(store.saves[0], memory.getState());
  deepStrictEqual(store.saves[0]!.transcript.map((c) => c.text), ["one", "two"]);
  strictEqual(store.saves[0]!.canvas.stickies.length, 1);

  t.mock.timers.tick(5000);
  strictEqual(store.saves.length, 1, "saved again with no further change");
});

test("snapshot: reset() cancels a pending save", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = recordingStore();
  const memory = new SessionMemory(new EventBus(), { snapshots: store });

  memory.appendChunk({ speaker: "Ana", text: "one" });
  memory.reset();
  t.mock.timers.tick(5000);

  strictEqual(store.saves.length, 0);
});

test("snapshot: hydrate() schedules no save", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = recordingStore();
  const memory = new SessionMemory(new EventBus(), { snapshots: store });
  const restored = emptySession("demo", "Restored");
  restored.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hi", seq: 1 });

  memory.hydrate(restored);
  t.mock.timers.tick(5000);

  strictEqual(store.saves.length, 0);
});

test("snapshot: setMuralState() saves the binding, and schedules no save when told not to", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const binding = { muralId: "workspace.12345", lastProjectedRev: 0, widgets: {}, layout: createLayoutState() };

  const unsaved = recordingStore();
  new SessionMemory(new EventBus(), { snapshots: unsaved }).setMuralState(binding, { save: false });
  t.mock.timers.tick(5000);
  strictEqual(unsaved.saves.length, 0);

  const saved = recordingStore();
  new SessionMemory(new EventBus(), { snapshots: saved }).setMuralState(binding);
  t.mock.timers.tick(500);
  strictEqual(saved.saves.length, 1);
  strictEqual(saved.saves[0]!.mural?.muralId, "workspace.12345");
});

test("snapshot: the default store writes nothing to the repository's data dir", async (t) => {
  const id = "default-store-writes-nothing";
  const sessionDir = join(SERVER_CONFIG.repoRoot, "data", "sessions", id);
  strictEqual(existsSync(sessionDir), false, `precondition: ${sessionDir} exists before the test`);
  t.after(() => rm(sessionDir, { recursive: true, force: true }));

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const memory = new SessionMemory(new EventBus(), { id });
  memory.appendChunk({ speaker: "Ana", text: "one" });
  t.mock.timers.tick(500);
  t.mock.timers.reset();
  // The debounced save has now run. A file store finishes its mkdir and write inside this wait.
  await new Promise((resolve) => setTimeout(resolve, 200));

  strictEqual(existsSync(sessionDir), false);
});

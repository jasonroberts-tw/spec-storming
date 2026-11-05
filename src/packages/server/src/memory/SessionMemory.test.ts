import { ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { emptySession } from "@specstorming/shared";
import { sessionContext } from "../agents/CoachAgent.ts";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "./SessionMemory.ts";

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

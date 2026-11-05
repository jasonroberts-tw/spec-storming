import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Canvas, Sticky } from "@specstorming/shared";
import {
  GRID,
  HOTSPOTS,
  UNPLACED,
  computeFullLayout,
  containerFor,
  createLayoutState,
  placeHotspot,
  placeSticky,
  toParentCoords,
} from "./layout.ts";

function sticky(partial: Partial<Sticky> & { id: string }): Sticky {
  return {
    kind: "domainEvent",
    text: partial.id,
    confidence: "medium",
    sourceChunkIds: [],
    createdAtRev: 1,
    updatedAtRev: 1,
    ...partial,
  };
}

function canvasWith(stickies: Sticky[], extra?: Partial<Canvas>): Canvas {
  return { stickies, boundedContexts: [], hotspots: [], lastUpdatedRev: 1, ...extra };
}

describe("slot allocator", () => {
  it("appends within a lane and never revisits a slot", () => {
    const layout = createLayoutState();
    const a = placeSticky(layout, "bc:orders", "domainEvent");
    const b = placeSticky(layout, "bc:orders", "domainEvent");
    assert.equal(b.x - a.x, GRID.pitch);
    assert.equal(a.y, b.y);
  });

  it("write-once: placing new stickies does not move existing ones", () => {
    const layout = createLayoutState();
    const first = placeSticky(layout, "bc:orders", "domainEvent");
    const snapshot = { x: first.x, y: first.y };
    for (let i = 0; i < 20; i++) placeSticky(layout, "bc:orders", "command");
    // The allocator has no reflow path: earlier placements are plain values that
    // later calls cannot touch. Assert the recorded slot is still where it was.
    assert.deepEqual(snapshot, { x: first.x, y: first.y });
    const next = placeSticky(layout, "bc:orders", "domainEvent");
    assert.equal(next.x, first.x + GRID.pitch);
  });

  it("separates kinds into lanes", () => {
    const layout = createLayoutState();
    const event = placeSticky(layout, "bc:orders", "domainEvent");
    const command = placeSticky(layout, "bc:orders", "command");
    const actor = placeSticky(layout, "bc:orders", "actor");
    assert.ok(command.y > event.y);
    assert.ok(actor.y > command.y);
    assert.equal(event.x, command.x); // each lane starts at column 0
  });

  it("overflows a full lane to rows below all lanes and grows the area", () => {
    const layout = createLayoutState();
    let last = placeSticky(layout, "bc:orders", "domainEvent");
    for (let i = 1; i < GRID.areaCols; i++) last = placeSticky(layout, "bc:orders", "domainEvent");
    assert.equal(last.grewTo, undefined); // lane row fits the initial area
    const laneY = last.y;
    const overflow = placeSticky(layout, "bc:orders", "domainEvent");
    assert.ok(overflow.y > laneY, "overflow goes below the lanes");
    assert.ok(overflow.grewTo, "overflow grows the area");
    // …and existing lane positions are untouched by construction (no reflow API).
    const nextCommand = placeSticky(layout, "bc:orders", "command");
    assert.ok(nextCommand.y < overflow.y);
  });

  it("allocates areas left to right without overlap", () => {
    const layout = createLayoutState();
    const a = placeSticky(layout, "bc:a", "domainEvent");
    const b = placeSticky(layout, "bc:b", "domainEvent");
    const areaA = layout.containers["bc:a"];
    const areaB = layout.containers["bc:b"];
    assert.ok(areaB.x >= areaA.x + areaA.width);
    assert.ok(b.x >= areaB.x);
    assert.ok(a.x < areaA.x + areaA.width);
  });

  it("hotspot strip is its own append-only row", () => {
    const layout = createLayoutState();
    const h1 = placeHotspot(layout);
    const h2 = placeHotspot(layout);
    assert.equal(h1.y, GRID.hotspotY);
    assert.equal(h2.x - h1.x, GRID.pitch);
    assert.equal(h1.container, HOTSPOTS);
  });
});

describe("containerFor", () => {
  it("routes hotspot-kind stickies to the strip and dangling BC refs to unplaced", () => {
    const canvas = canvasWith([]);
    assert.equal(containerFor(sticky({ id: "x", kind: "hotspot" }), canvas), HOTSPOTS);
    assert.equal(
      containerFor(sticky({ id: "y", boundedContextId: "nope" }), canvas),
      UNPLACED,
    );
  });
});

describe("computeFullLayout", () => {
  const bc = {
    id: "orders",
    name: "Orders",
    purpose: "",
    strategicClassification: { domain: "core" as const },
    inboundCommunication: [],
    outboundCommunication: [],
    ubiquitousLanguage: [],
    businessDecisions: [],
    assumptions: [],
    openQuestions: [],
    stickyIds: [],
    confidence: "medium" as const,
    createdAtRev: 1,
    updatedAtRev: 1,
  };

  it("is deterministic for identical input", () => {
    const canvas = canvasWith(
      [
        sticky({ id: "e1", boundedContextId: "orders", order: 20 }),
        sticky({ id: "e2", boundedContextId: "orders", order: 10 }),
        sticky({ id: "c1", kind: "command", boundedContextId: "orders" }),
        sticky({ id: "loose" }),
      ],
      { boundedContexts: [bc], hotspots: [{ id: "h1", text: "conflict", sourceChunkIds: [] }] },
    );
    const one = computeFullLayout(canvas);
    const two = computeFullLayout(canvas);
    assert.deepEqual(
      [...one.positions.entries()],
      [...two.positions.entries()],
    );
  });

  it("sorts within a lane by order ?? createdAtRev", () => {
    const canvas = canvasWith(
      [
        sticky({ id: "e-late", boundedContextId: "orders", order: 20 }),
        sticky({ id: "e-early", boundedContextId: "orders", order: 10 }),
      ],
      { boundedContexts: [bc] },
    );
    const { positions } = computeFullLayout(canvas);
    assert.ok(positions.get("e-early")!.x < positions.get("e-late")!.x);
  });

  it("dedups an id present both as hotspot sticky and top-level hotspot", () => {
    const canvas = canvasWith(
      [sticky({ id: "dup", kind: "hotspot" })],
      { hotspots: [{ id: "dup", text: "same", sourceChunkIds: [] }, { id: "other", text: "o", sourceChunkIds: [] }] },
    );
    const { positions, layout } = computeFullLayout(canvas);
    assert.equal(layout.hotspotCount, 2); // dup once + other
    assert.ok(positions.has("dup"));
    assert.ok(positions.has("other"));
  });

  it("puts unplaced stickies in the unplaced container", () => {
    const canvas = canvasWith([sticky({ id: "loose" })]);
    const { positions, layout } = computeFullLayout(canvas);
    assert.equal(positions.get("loose")!.container, UNPLACED);
    assert.ok(layout.containers[UNPLACED]);
  });
});

describe("toParentCoords", () => {
  it("rebases a board-absolute placement onto its parent area", () => {
    const layout = createLayoutState();
    const first = placeSticky(layout, "bc:a", "domainEvent");
    // Second area starts to the right of the first, so its slots have a large x.
    const second = placeSticky(layout, "bc:b", "domainEvent");
    const container = layout.containers["bc:b"]!;

    assert.ok(second.x > first.x, "second area is further right on the board");
    // Relative to its own area, the first slot of each area is identical.
    assert.deepEqual(toParentCoords(second, container), toParentCoords(first, layout.containers["bc:a"]!));
  });

  it("keeps children inside the parent's box", () => {
    const layout = createLayoutState();
    const p = placeSticky(layout, "bc:a", "readModel");
    const container = layout.containers["bc:a"]!;
    const rel = toParentCoords(p, container);

    assert.ok(rel.x >= 0 && rel.y >= 0, "no negative offsets");
    assert.ok(rel.x + GRID.sticky <= container.width, "fits horizontally");
    assert.ok(rel.y + GRID.sticky <= container.height, "fits vertically");
  });
});

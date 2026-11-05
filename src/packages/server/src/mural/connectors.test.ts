import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Canvas, Sticky, StickyLink } from "@specstorming/shared";
import { LINK_PREFIX, desiredLinkKeys, linkKey } from "./MuralProjector.ts";

function sticky(id: string, links?: StickyLink[]): Sticky {
  return {
    id,
    kind: "domainEvent",
    text: id,
    confidence: "medium",
    sourceChunkIds: [],
    links,
    createdAtRev: 1,
    updatedAtRev: 1,
  };
}

function canvasOf(stickies: Sticky[]): Canvas {
  return { stickies, boundedContexts: [], hotspots: [], lastUpdatedRev: 1 };
}

describe("connector diff", () => {
  it("keys a link by both endpoints and the relation", () => {
    const key = linkKey("place-order", "triggers", "order-placed");
    assert.ok(key.startsWith(LINK_PREFIX));
    // Direction matters: the reverse link is a different connector.
    assert.notEqual(key, linkKey("order-placed", "triggers", "place-order"));
    // So does the relation: two stickies can be joined more than one way.
    assert.notEqual(key, linkKey("place-order", "reads", "order-placed"));
  });

  it("wants one connector per link once both ends are projected", () => {
    const canvas = canvasOf([
      sticky("place-order", [{ toId: "order-placed", relation: "triggers" }]),
      sticky("order-placed"),
    ]);
    const keys = desiredLinkKeys(canvas, new Set(["place-order", "order-placed"]));
    assert.deepEqual([...keys], [linkKey("place-order", "triggers", "order-placed")]);
  });

  it("defers a link whose target is not on the board yet", () => {
    const canvas = canvasOf([
      sticky("place-order", [{ toId: "not-yet", relation: "triggers" }]),
    ]);
    assert.equal(desiredLinkKeys(canvas, new Set(["place-order"])).size, 0);
  });

  it("defers a link whose source is not on the board yet", () => {
    const canvas = canvasOf([
      sticky("place-order", [{ toId: "order-placed", relation: "triggers" }]),
      sticky("order-placed"),
    ]);
    assert.equal(desiredLinkKeys(canvas, new Set(["order-placed"])).size, 0);
  });

  it("is stable across passes, so an unchanged link is never redrawn", () => {
    const canvas = canvasOf([
      sticky("place-order", [{ toId: "order-placed", relation: "triggers" }]),
      sticky("order-placed"),
    ]);
    const projected = new Set(["place-order", "order-placed"]);
    assert.deepEqual([...desiredLinkKeys(canvas, projected)], [...desiredLinkKeys(canvas, projected)]);
  });

  it("drops a connector when the synthesizer removes its link", () => {
    const projected = new Set(["place-order", "order-placed"]);
    const before = desiredLinkKeys(
      canvasOf([
        sticky("place-order", [{ toId: "order-placed", relation: "triggers" }]),
        sticky("order-placed"),
      ]),
      projected,
    );
    const after = desiredLinkKeys(
      canvasOf([sticky("place-order", []), sticky("order-placed")]),
      projected,
    );

    const stale = [...before].filter((k) => !after.has(k));
    assert.deepEqual(stale, [linkKey("place-order", "triggers", "order-placed")]);
  });

  it("keeps both connectors when two relations join the same pair", () => {
    const canvas = canvasOf([
      sticky("policy-x", [
        { toId: "order-placed", relation: "reads" },
        { toId: "order-placed", relation: "invokes" },
      ]),
      sticky("order-placed"),
    ]);
    assert.equal(desiredLinkKeys(canvas, new Set(["policy-x", "order-placed"])).size, 2);
  });
});

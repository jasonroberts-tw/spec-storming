import type {
  Canvas,
  Confidence,
  DomainKind,
  MuralContainerState,
  MuralLayoutState,
  Sticky,
  StickyKind,
} from "@specstorming/shared";

/**
 * Layout engine for the Mural projection. The canvas model has no geometry, so this
 * module invents board-absolute coordinates: one area per bounded context, member
 * stickies in kind-lanes inside it, an "unplaced" parking-lot area, and a hotspot
 * strip along the bottom.
 *
 * Stability contract (design D3): placement is write-once — an item gets coordinates
 * exactly once, from its container's next free slot. The only layout-initiated move is
 * a boundedContextId change. When a lane is full, placement overflows to shared rows at
 * the bottom of the area (growing the area, never repositioning existing stickies).
 * The explicit "tidy" action rebuilds everything from scratch via computeFullLayout.
 *
 * Every coordinate here is board-absolute, including slots inside an area. Stickies ARE
 * nested under their area via parentId, and Mural measures a child from its parent's
 * top-left — but that rebase happens at the API boundary via toParentCoords, so the
 * allocator, the hotspot strip, and area rects all stay in one coordinate system.
 */

export const GRID = {
  sticky: 138, // Mural default sticky size
  pitch: 168, // sticky + 30px gutter
  areaCols: 6, // slots per row inside an area
  areaPad: 24, // inner padding, left/bottom
  areaHeader: 100, // room for the area title above the first row (Mural title bar ~80px)
  areaGap: 80, // horizontal gap between areas
  hotspotY: 24, // hotspot strip sits at the very top of the board
  hotspotX0: 24,
  areaTopOffset: 300, // areas start below the hotspot strip (hotspotY + sticky + gap)
};

/** Kind-lanes inside an area, top to bottom, in EventStorming reading order. */
export const LANES: StickyKind[][] = [
  ["domainEvent"],
  ["command"],
  ["actor", "policy"],
  ["readModel", "externalSystem", "aggregate"],
];

export const UNPLACED = "unplaced";
export const HOTSPOTS = "hotspots";

export function laneFor(kind: StickyKind): number {
  const i = LANES.findIndex((lane) => lane.includes(kind));
  return i >= 0 ? i : LANES.length - 1;
}

export function containerFor(sticky: Pick<Sticky, "kind" | "boundedContextId">, canvas: Canvas): string {
  if (sticky.kind === "hotspot") return HOTSPOTS;
  const bc = sticky.boundedContextId;
  // A dangling boundedContextId (no such BC on the canvas yet) parks the sticky.
  if (bc && canvas.boundedContexts.some((b) => b.id === bc)) return `bc:${bc}`;
  return UNPLACED;
}

// ---- styles -----------------------------------------------------------------

/** Classic EventStorming sticky colors. Mural requires 8-digit RRGGBBAA hex (spike S2: 6-digit is rejected with a 400). */
export const KIND_COLOR: Record<StickyKind, string> = {
  domainEvent: "#FFB84DFF", // orange
  command: "#7FB5FFFF", // blue
  actor: "#FFF599FF", // small yellow
  policy: "#D0B0FFFF", // lilac
  readModel: "#A9E5A5FF", // green
  externalSystem: "#FFC2D1FF", // pink
  hotspot: "#FF5A5FFF", // bright red/pink
  aggregate: "#F5E663FF", // pale yellow
};

/** Area border color by strategic classification. */
export const DOMAIN_BORDER: Record<DomainKind, string> = {
  core: "#D4A017FF",
  supporting: "#7A9CC6FF",
  generic: "#9AA5B1FF",
};

export interface StickyStyle {
  backgroundColor: string;
  italic?: boolean;
}

/** Low confidence renders italic (the board analog of the web UI's translucent-dashed). */
export function stickyStyle(kind: StickyKind, confidence: Confidence): StickyStyle {
  const style: StickyStyle = { backgroundColor: KIND_COLOR[kind] };
  if (confidence === "low") style.italic = true;
  return style;
}

/** Human-readable uppercase label for each sticky kind, shown as a header on the card. */
const KIND_LABEL: Record<StickyKind, string> = {
  domainEvent: "EVENT",
  command: "COMMAND",
  actor: "ACTOR",
  policy: "POLICY",
  readModel: "READ MODEL",
  externalSystem: "EXTERNAL SYSTEM",
  aggregate: "AGGREGATE",
  hotspot: "HOTSPOT",
};

/**
 * Format sticky text for display on the Mural board.
 * Prepends a bold kind label so each card is self-describing:
 *   <b>COMMAND</b>
 *   Research Market Opportunity
 *
 * Hotspots skip the label — they are already identified by color and placement.
 */
export function stickyText(kind: StickyKind, text: string): string {
  if (kind === "hotspot") return text;
  return `${KIND_LABEL[kind]}\n${text}`;
}

// ---- slot allocation --------------------------------------------------------

export function createLayoutState(): MuralLayoutState {
  return { containers: {}, nextAreaX: 0, hotspotCount: 0 };
}

function initialAreaHeight(): number {
  return GRID.areaHeader + LANES.length * GRID.pitch + GRID.areaPad;
}

function areaWidth(): number {
  return GRID.areaPad * 2 + GRID.areaCols * GRID.pitch - (GRID.pitch - GRID.sticky);
}

/** Get or allocate a container's rect at the next free area position. */
export function ensureContainer(layout: MuralLayoutState, id: string): MuralContainerState {
  const existing = layout.containers[id];
  if (existing) return existing;
  const container: MuralContainerState = {
    id,
    x: layout.nextAreaX,
    y: GRID.areaTopOffset,
    width: areaWidth(),
    height: initialAreaHeight(),
    laneCounts: LANES.map(() => 0),
    overflowCount: 0,
  };
  layout.nextAreaX += container.width + GRID.areaGap;
  layout.containers[id] = container;
  return container;
}

export interface Placement {
  x: number;
  y: number;
  container: string;
  /** Set when this placement grew the container; PATCH the area to this height. */
  grewTo?: number;
}

/**
 * Allocate the next free slot for a sticky of `kind` in `containerId`. Lanes are fixed
 * rows; a full lane overflows to shared rows below all lanes (mixed kinds, cleaned up
 * by tidy) so existing stickies never move.
 */
export function placeSticky(
  layout: MuralLayoutState,
  containerId: string,
  kind: StickyKind,
): Placement {
  const c = ensureContainer(layout, containerId);
  const lane = laneFor(kind);
  let col: number;
  let row: number;
  if (c.laneCounts[lane] < GRID.areaCols) {
    col = c.laneCounts[lane];
    row = lane;
    c.laneCounts[lane] += 1;
  } else {
    const idx = c.overflowCount;
    c.overflowCount += 1;
    col = idx % GRID.areaCols;
    row = LANES.length + Math.floor(idx / GRID.areaCols);
  }
  const x = c.x + GRID.areaPad + col * GRID.pitch;
  const y = c.y + GRID.areaHeader + row * GRID.pitch;
  const placement: Placement = { x, y, container: containerId };
  const needed = GRID.areaHeader + (row + 1) * GRID.pitch + GRID.areaPad - (GRID.pitch - GRID.sticky);
  if (needed > c.height) {
    c.height = needed;
    placement.grewTo = needed;
  }
  return placement;
}

/**
 * Board-absolute placement → coordinates relative to its parent area.
 *
 * The allocator works in board-absolute space throughout (so the hotspot strip,
 * area rects, and connector geometry all share one coordinate system), but Mural
 * measures a child widget from its parent's top-left once `parentId` is set.
 * Convert only at the API boundary.
 */
export function toParentCoords(
  p: { x: number; y: number },
  container: Pick<MuralContainerState, "x" | "y">,
): { x: number; y: number } {
  return { x: p.x - container.x, y: p.y - container.y };
}

/** Allocate the next slot in the hotspot strip (rotated pink stickies, no area). */
export function placeHotspot(layout: MuralLayoutState): Placement {
  const i = layout.hotspotCount;
  layout.hotspotCount += 1;
  return {
    x: GRID.hotspotX0 + i * GRID.pitch,
    y: GRID.hotspotY,
    container: HOTSPOTS,
  };
}

// ---- full layout (tidy / fresh backfill) ------------------------------------

export interface FullLayout {
  layout: MuralLayoutState;
  /** Canvas item id → placement, for every sticky and top-level hotspot. */
  positions: Map<string, Placement>;
}

/**
 * Pure full-board layout: fresh allocator state, items placed in ideal order —
 * bounded contexts by creation, "unplaced" last, stickies within a lane sorted by
 * `order ?? createdAtRev`. Deterministic for identical input. Used by the tidy
 * action; incremental passes only ever append via placeSticky/placeHotspot.
 */
export function computeFullLayout(canvas: Canvas): FullLayout {
  const layout = createLayoutState();
  const positions = new Map<string, Placement>();

  const containerIds = [
    ...[...canvas.boundedContexts]
      .sort((a, b) => a.createdAtRev - b.createdAtRev)
      .map((b) => `bc:${b.id}`),
  ];
  const byContainer = new Map<string, Sticky[]>();
  for (const s of canvas.stickies) {
    const id = containerFor(s, canvas);
    if (id === HOTSPOTS) continue; // handled with the hotspot strip below
    byContainer.set(id, [...(byContainer.get(id) ?? []), s]);
  }
  if (byContainer.has(UNPLACED)) containerIds.push(UNPLACED);

  for (const containerId of containerIds) {
    ensureContainer(layout, containerId);
    const members = [...(byContainer.get(containerId) ?? [])].sort((a, b) => {
      const la = laneFor(a.kind);
      const lb = laneFor(b.kind);
      if (la !== lb) return la - lb;
      return (a.order ?? a.createdAtRev) - (b.order ?? b.createdAtRev);
    });
    for (const s of members) positions.set(s.id, placeSticky(layout, containerId, s.kind));
  }

  // Hotspot strip: kind:"hotspot" stickies and top-level hotspots, unified by id.
  const hotspotStickies = canvas.stickies
    .filter((s) => s.kind === "hotspot")
    .sort((a, b) => (a.order ?? a.createdAtRev) - (b.order ?? b.createdAtRev));
  for (const s of hotspotStickies) positions.set(s.id, placeHotspot(layout));
  for (const h of canvas.hotspots) {
    if (positions.has(h.id)) continue; // same id exists as a hotspot sticky
    positions.set(h.id, placeHotspot(layout));
  }

  return { layout, positions };
}

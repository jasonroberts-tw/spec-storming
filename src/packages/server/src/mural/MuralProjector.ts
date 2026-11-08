import type { Canvas, MuralWidgetEntry, ServerEvent } from "@specstorming/shared";
import { MURAL_CONFIG } from "../config.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";
import type { MuralAuth } from "./auth.ts";
import { MuralApiError, type MuralMcp, type StickyCreate } from "./muralMcp.ts";
import {
  DOMAIN_BORDER,
  GRID,
  HOTSPOTS,
  computeFullLayout,
  containerFor,
  createLayoutState,
  ensureContainer,
  laneFor,
  placeHotspot,
  placeSticky,
  stickyStyle,
  stickyText,
  toParentCoords,
  UNPLACED,
} from "./layout.ts";

/**
 * One-way projection of the canvas onto a bound Mural board. A new EventBus
 * subscriber beside SSE and hint pruning — the synthesizer, update_canvas tool,
 * and every existing reader are untouched.
 *
 * Passes are serialized with dirty/running coalescing (same pattern as the
 * SynthesizerAgent). Failure tolerance: any Mural error marks the projector
 * degraded and leaves lastProjectedRev unadvanced so the next pass re-diffs the
 * missed range; session processing is never blocked. Layout slot cursors are
 * mutated in place even when a pass later fails — a retry then allocates fresh
 * slots (leaving gaps, cleaned up by tidy) rather than risking overlapping
 * placements on top of widgets that WERE created before the failure.
 */

/** Set true if spike S2 confirms backgroundColor is dropped on batch create. */
const COLOR_FIX_PATCH = false;

const ROTATION_HOTSPOT = 0;

/** Connectors are single-create; bound the burst so one pass can't stall on them. */
const MAX_NEW_CONNECTORS_PER_PASS = 50;

export const LINK_PREFIX = "link:";
/** Pseudo-container for connectors — they belong to no area. */
const LINKS = "links";

/** Stable key for a link, so a connector is drawn at most once per relation. */
export function linkKey(fromId: string, relation: string, toId: string): string {
  return `${LINK_PREFIX}${fromId}-${relation}->${toId}`;
}

/**
 * Connector keys the board should hold for `canvas`, given what is already projected.
 * A link is skipped until both endpoints have widgets — the next pass picks it up.
 */
export function desiredLinkKeys(canvas: Canvas, projected: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const s of canvas.stickies) {
    if (!projected.has(s.id)) continue;
    for (const l of s.links ?? []) {
      if (projected.has(l.toId)) keys.add(linkKey(s.id, l.relation, l.toId));
    }
  }
  return keys;
}

export class MuralProjector {
  private running = false;
  private dirty = false;
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when this pass forgot a board-deleted widget that must be recreated. */
  private healed = false;
  /** Set when the last pass failed; cleared by the next successful pass. */
  degraded?: string;

  constructor(
    private readonly memory: SessionMemory,
    private readonly bus: EventBus,
    private readonly auth: MuralAuth,
    private readonly client: MuralMcp,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((e: ServerEvent) => {
      if (e.type === "canvas.updated") this.requestPass();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    void this.client.close();
  }

  async status(): Promise<{
    state: "unconfigured" | "disconnected" | "connected" | "bound" | "degraded";
    muralId?: string;
    embedUrl?: string;
    detail?: string;
  }> {
    if (!this.auth.configured) return { state: "unconfigured" };
    if (!(await this.auth.connected())) return { state: "disconnected" };
    const ms = this.memory.muralState();
    if (!ms) return { state: "connected" };
    // Lazy backfill for sessions bound before embedLink capture (or before the
    // user enabled embedding on the mural). Best-effort: status never throws.
    // The link is set in memory only, and the next change to the session saves it. After a
    // restart the session is still the empty startup session, so a save here would replace the
    // snapshot the binding came from.
    if (!ms.embedUrl) {
      try {
        const mural = await this.client.getMural(ms.muralId);
        if (mural.embedLink) ms.embedUrl = mural.embedLink;
      } catch {
        /* embed link stays absent; UI falls back to the React canvas */
      }
    }
    return {
      state: this.degraded ? "degraded" : "bound",
      muralId: ms.muralId,
      embedUrl: ms.embedUrl,
      detail: this.degraded,
    };
  }

  /** Bind the session to a mural (verifying it's reachable) and backfill the
   * whole current canvas. Rebinding resets projection state. */
  async bind(muralId: string): Promise<void> {
    const mural = await this.client.getMural(muralId); // throws if unreachable/unauthorized
    this.memory.setMuralState({
      muralId,
      embedUrl: mural.embedLink, // absent until embedding is enabled on the mural
      lastProjectedRev: 0,
      widgets: {},
      layout: createLayoutState(),
    });
    this.degraded = undefined;
    // Backfill is user-initiated, so skip the debounce and start immediately.
    this.requestPass({ immediate: true }); // lastProjectedRev=0 → projects everything, batched
  }

  /**
   * Coalesced trigger: at most one pass in flight, one more queued.
   *
   * The dirty/running flags only merge passes that *overlap*; a burst of quick
   * synthesis passes would otherwise cost one round of board writes each. A short
   * trailing debounce collapses that burst into a single pass.
   */
  requestPass({ immediate = false }: { immediate?: boolean } = {}): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (immediate) {
      this.debounceTimer = null;
      void this.runPass();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.running) void this.runPass();
      else this.dirty = true;
    }, MURAL_CONFIG.debounceMs);
  }

  /** Explicit full-board reflow: recompute ideal layout, PATCH every widget into
   * place, rebuild allocator state. Never runs implicitly. */
  async tidy(): Promise<{ moved: number }> {
    const ms = this.memory.muralState();
    if (!ms) throw new Error("no mural bound");
    if (this.running) throw new Error("projection in progress; retry shortly");
    this.running = true;
    this.healed = false;
    // Stickies moved, which the response reports, and areas moved, which it does not.
    let moved = 0;
    let areasMoved = 0;
    try {
      const canvas = this.memory.getState().canvas;
      const { layout, positions } = computeFullLayout(canvas);
      // Carry board widget ids/titles into the rebuilt allocator state.
      for (const [id, container] of Object.entries(layout.containers)) {
        const prev = ms.layout.containers[id];
        if (prev) {
          container.areaWidgetId = prev.areaWidgetId;
          container.title = prev.title;
        }
      }
      for (const container of Object.values(layout.containers)) {
        if (!container.areaWidgetId) continue;
        const widgetId = container.areaWidgetId;
        const ok = await this.patchOrForget(`area:${container.id}`, () =>
          this.client.updateArea(ms.muralId, widgetId, {
            x: container.x,
            y: container.y,
            width: container.width,
            height: container.height,
          }),
        );
        if (!ok) {
          container.areaWidgetId = undefined;
          continue;
        }
        const areaEntry = ms.widgets[`area:${container.id}`];
        if (areaEntry) {
          areaEntry.x = container.x;
          areaEntry.y = container.y;
        }
        areasMoved += 1;
      }
      for (const [canvasId, p] of positions) {
        const entry = ms.widgets[canvasId];
        if (!entry) continue; // not yet projected; the next pass will create it
        // PATCH unconditionally: our recorded x/y can't see human drags on the board,
        // and restoring those to the computed layout is exactly what tidy is for.
        // Reflow can also move a sticky between areas, so reparent alongside.
        const target = layout.containers[p.container];
        const rel = target?.areaWidgetId ? toParentCoords(p, target) : p;
        const ok = await this.patchOrForget(canvasId, () =>
          this.client.updateSticky(ms.muralId, entry.widgetId, {
            x: rel.x,
            y: rel.y,
            parentId: target?.areaWidgetId ?? "",
          }),
        );
        if (!ok) continue;
        entry.x = p.x;
        entry.y = p.y;
        entry.container = p.container;
        moved += 1;
      }
      ms.layout = layout;
      if (this.healed) {
        // Unlike a normal pass, tidy has no fresh revision to re-diff against — a
        // healed sticky's updatedAtRev is already behind the watermark, so rewinding
        // is the only way it gets recreated. A full re-diff is idempotent: creates are
        // keyed off ms.widgets, and PATCHes are skipped when content already matches.
        ms.lastProjectedRev = 0;
        this.dirty = true;
      }
      this.degraded = undefined;
      return { moved };
    } catch (err) {
      this.degraded = String(err instanceof Error ? err.message : err);
      throw err;
    } finally {
      // Save only when this tidy moved or healed a widget. After a restart, before a hydrate,
      // the session is still the empty startup session, and a save would replace the snapshot.
      if (moved > 0 || areasMoved > 0 || this.healed) this.memory.persistMural();
      this.running = false;
      if (this.dirty) {
        this.dirty = false;
        void this.runPass();
      }
    }
  }

  private async runPass(): Promise<void> {
    const ms = this.memory.muralState();
    if (!ms || !this.auth.configured) return;
    if (!(await this.auth.connected())) return;

    const state = this.memory.getState();
    const canvas = state.canvas;
    const rev = state.revision;
    if (rev <= ms.lastProjectedRev) return;

    this.running = true;
    this.healed = false;
    try {
      // Remove widgets for canvas items that no longer exist (e.g. deduped stickies).
      await this.projectDeletions(ms.muralId, canvas);
      await this.projectAreas(ms.muralId, canvas, ms.lastProjectedRev);
      const growth = new Map<string, number>();
      await this.projectNewItems(ms.muralId, canvas, ms.lastProjectedRev, growth);
      await this.projectUpdates(ms.muralId, canvas, ms.lastProjectedRev, growth);
      await this.growAreas(ms.muralId, growth);
      // Last: every endpoint a link could reference now has a widget id.
      await this.projectLinks(ms.muralId, canvas);
      if (this.healed) {
        // Hold the watermark so the next pass re-diffs this same range and recreates
        // whatever was deleted on the board. Creates are keyed off ms.widgets, so the
        // widgets that survived are not duplicated.
        this.dirty = true;
      } else {
        ms.lastProjectedRev = rev;
      }
      this.degraded = undefined;
    } catch (err) {
      // Fail soft: lastProjectedRev stays put, so the next pass re-diffs the missed
      // range; already-created widgets are recorded and won't duplicate.
      this.degraded = String(err instanceof Error ? err.message : err);
      console.error("[mural] projection pass failed:", err);
    } finally {
      this.memory.persistMural();
      this.running = false;
      if (this.dirty) {
        this.dirty = false;
        void this.runPass();
      }
    }
  }

  /**
   * Delete Mural widgets for sticky/hotspot ids that no longer exist in the canvas
   * (e.g. duplicates removed by the dedup logic in SessionMemory). Area and connector
   * widgets are intentionally left to their own lifecycle steps.
   */
  private async projectDeletions(muralId: string, canvas: Canvas): Promise<void> {
    const ms = this.memory.muralState()!;
    const validIds = new Set<string>([
      ...canvas.stickies.map((s) => s.id),
      ...canvas.hotspots.map((h) => h.id),
    ]);
    for (const key of Object.keys(ms.widgets)) {
      if (key.startsWith("area:") || key.startsWith(LINK_PREFIX)) continue;
      if (validIds.has(key)) continue;
      const entry = ms.widgets[key]!;
      console.log(`[mural] deleting orphaned widget for removed canvas item: ${key}`);
      await this.patchOrForget(key, () => this.client.deleteWidget(muralId, entry.widgetId));
      delete ms.widgets[key];
    }
  }

  /** Create areas for new bounded contexts; rename areas whose BC name changed. */
  private async projectAreas(muralId: string, canvas: Canvas, sinceRev: number): Promise<void> {
    const ms = this.memory.muralState()!;
    for (const bc of canvas.boundedContexts) {
      const containerId = `bc:${bc.id}`;
      const key = `area:${containerId}`;
      const entry = ms.widgets[key];
      // Skip creating an area for a BC that has no stickies yet; wait until it does.
      const hasStickies = canvas.stickies.some((s) => s.boundedContextId === bc.id);
      if (!entry && !hasStickies) continue;
      const container = ensureContainer(ms.layout, containerId);
      if (!entry) {
        const created = await this.client.createArea(muralId, {
          x: container.x,
          y: container.y,
          width: container.width,
          height: container.height,
          title: bc.name,
          style: { borderColor: DOMAIN_BORDER[bc.strategicClassification.domain] },
        });
        container.areaWidgetId = created.id;
        container.title = bc.name;
        ms.widgets[key] = {
          widgetId: created.id,
          container: containerId,
          x: container.x,
          y: container.y,
          text: bc.name,
        };
        this.memory.persistMural();
      } else if (bc.updatedAtRev > sinceRev && entry.text !== bc.name) {
        const ok = await this.patchOrForget(key, () =>
          this.client.updateArea(muralId, entry.widgetId, { title: bc.name }),
        );
        if (ok) {
          entry.text = bc.name;
          container.title = bc.name;
        }
      }
    }
  }

  /** Place and batch-create all new stickies + new top-level hotspots in one call. */
  private async projectNewItems(
    muralId: string,
    canvas: Canvas,
    sinceRev: number,
    growth: Map<string, number>,
  ): Promise<void> {
    const ms = this.memory.muralState()!;
    const newStickies = canvas.stickies
      .filter((s) => s.updatedAtRev > sinceRev && !ms.widgets[s.id])
      // Nicer append order inside a pass: by container, lane, then order/arrival.
      .sort((a, b) => {
        const ca = containerFor(a, canvas);
        const cb = containerFor(b, canvas);
        if (ca !== cb) return ca < cb ? -1 : 1;
        const la = laneFor(a.kind);
        const lb = laneFor(b.kind);
        if (la !== lb) return la - lb;
        return (a.order ?? a.createdAtRev) - (b.order ?? b.createdAtRev);
      });
    const newIds = new Set(newStickies.map((s) => s.id));
    // Top-level hotspots share the sticky id space: same id → one widget (sticky wins).
    const newHotspots = canvas.hotspots.filter((h) => !ms.widgets[h.id] && !newIds.has(h.id));
    if (newStickies.length === 0 && newHotspots.length === 0) return;

    // Build a dedup index from already-projected widgets: container → Set<"kind:text">.
    // This catches duplicates across passes (including after a server restart where
    // ms.widgets was restored from a snapshot) regardless of what the canvas model says.
    const projectedInContainer = new Map<string, Set<string>>();
    const projectedHotspotTexts = new Set<string>();
    for (const entry of Object.values(ms.widgets)) {
      if (!entry.kind) continue; // area/connector entry — not a sticky
      const key = `${entry.kind}:${entry.text.trim().toLowerCase()}`;
      if (entry.container === HOTSPOTS) {
        projectedHotspotTexts.add(entry.text.trim().toLowerCase());
      } else {
        const set = projectedInContainer.get(entry.container) ?? new Set<string>();
        set.add(key);
        projectedInContainer.set(entry.container, set);
      }
    }

    const batch: { canvasId: string; entry: Omit<MuralWidgetEntry, "widgetId">; create: StickyCreate }[] = [];
    for (const s of newStickies) {
      const containerId = containerFor(s, canvas);
      // Skip if an identical kind+text widget already exists in this container.
      const dupKey = `${s.kind}:${s.text.trim().toLowerCase()}`;
      const containerSet = projectedInContainer.get(containerId);
      if (containerSet?.has(dupKey)) {
        console.log(`[mural] skipping duplicate sticky "${s.text}" (${s.kind}) in ${containerId}`);
        continue;
      }
      const p =
        containerId === HOTSPOTS
          ? placeHotspot(ms.layout)
          : placeSticky(ms.layout, containerId, s.kind);
      if (p.grewTo) growth.set(containerId, p.grewTo);
      // Register in the local dedup index so a second sticky in this same pass is also blocked.
      const set = projectedInContainer.get(p.container) ?? new Set<string>();
      set.add(dupKey);
      projectedInContainer.set(p.container, set);
      batch.push({
        canvasId: s.id,
        entry: { container: p.container, x: p.x, y: p.y, text: s.text, kind: s.kind, confidence: s.confidence },
        create: {
          x: p.x,
          y: p.y,
          width: GRID.sticky,
          height: GRID.sticky,
          shape: "rectangle",
          text: stickyText(s.kind, s.text),
          rotation: s.kind === "hotspot" ? ROTATION_HOTSPOT : undefined,
          style: stickyStyle(s.kind, s.confidence),
        },
      });
    }
    for (const h of newHotspots) {
      // Skip if an identical hotspot text is already on the board.
      if (projectedHotspotTexts.has(h.text.trim().toLowerCase())) {
        console.log(`[mural] skipping duplicate hotspot "${h.text}"`);
        continue;
      }
      projectedHotspotTexts.add(h.text.trim().toLowerCase());
      const p = placeHotspot(ms.layout);
      batch.push({
        canvasId: h.id,
        entry: { container: HOTSPOTS, x: p.x, y: p.y, text: h.text, kind: "hotspot" },
        create: {
          x: p.x,
          y: p.y,
          width: GRID.sticky,
          height: GRID.sticky,
          shape: "rectangle",
          text: stickyText("hotspot", h.text),
          rotation: ROTATION_HOTSPOT,
          style: stickyStyle("hotspot", "medium"),
        },
      });
    }

    // The parking-lot area is created lazily, the first time something lands in it.
    const unplacedContainer = ms.layout.containers[UNPLACED];
    if (unplacedContainer && !unplacedContainer.areaWidgetId) {
      const created = await this.client.createArea(muralId, {
        x: unplacedContainer.x,
        y: unplacedContainer.y,
        width: unplacedContainer.width,
        height: unplacedContainer.height,
        title: "Unplaced",
      });
      unplacedContainer.areaWidgetId = created.id;
      unplacedContainer.title = "Unplaced";
      ms.widgets[`area:${UNPLACED}`] = {
        widgetId: created.id,
        container: UNPLACED,
        x: unplacedContainer.x,
        y: unplacedContainer.y,
        text: "Unplaced",
      };
      this.memory.persistMural();
    }

    // Nest each sticky under its area, now that every container it could land in
    // exists on the board (bounded contexts from projectAreas, the parking lot just
    // above). Placement runs in board-absolute space, so rebase onto the parent here.
    for (const b of batch) {
      const parentId = ms.layout.containers[b.entry.container]?.areaWidgetId;
      if (!parentId) continue; // hotspot strip has no area — stays board-absolute
      b.create.parentId = parentId;
      const rel = toParentCoords(b.create, ms.layout.containers[b.entry.container]!);
      b.create.x = rel.x;
      b.create.y = rel.y;
    }

    const created = await this.client.createStickies(
      muralId,
      batch.map((b) => b.create),
    );
    created.forEach((w, i) => {
      const b = batch[i];
      if (b) ms.widgets[b.canvasId] = { widgetId: w.id, ...b.entry };
    });
    this.memory.persistMural();

    if (COLOR_FIX_PATCH) {
      for (const b of batch) {
        const entry = ms.widgets[b.canvasId];
        if (entry && b.create.style) {
          await this.client.updateSticky(muralId, entry.widgetId, { style: b.create.style });
        }
      }
    }
  }

  /** PATCH changed stickies/hotspots. Position is written ONLY on a bounded-context
   * reassignment — text/style updates never move a widget (write-once placement). */
  private async projectUpdates(
    muralId: string,
    canvas: Canvas,
    sinceRev: number,
    growth: Map<string, number>,
  ): Promise<void> {
    const ms = this.memory.muralState()!;
    const changed = canvas.stickies.filter(
      (s) => s.updatedAtRev > sinceRev && ms.widgets[s.id],
    );
    for (const s of changed) {
      const entry = ms.widgets[s.id]!;
      const patch: Partial<StickyCreate> = {};
      if (entry.text !== s.text) patch.text = stickyText(s.kind, s.text);
      if (entry.kind !== s.kind || entry.confidence !== s.confidence) {
        patch.style = stickyStyle(s.kind, s.confidence);
        patch.rotation = s.kind === "hotspot" ? ROTATION_HOTSPOT : 0;
      }
      const desired = containerFor(s, canvas);
      if (desired !== entry.container) {
        const p =
          desired === HOTSPOTS
            ? placeHotspot(ms.layout)
            : placeSticky(ms.layout, desired, s.kind);
        if (p.grewTo) growth.set(desired, p.grewTo);
        // Reparent and reposition together: coordinates are read relative to whichever
        // area the widget ends up in, so sending one without the other misplaces it.
        const target = ms.layout.containers[desired];
        patch.parentId = target?.areaWidgetId ?? "";
        const rel = target?.areaWidgetId ? toParentCoords(p, target) : p;
        patch.x = rel.x;
        patch.y = rel.y;
        entry.container = desired;
        entry.x = p.x;
        entry.y = p.y;
      }
      if (Object.keys(patch).length > 0) {
        const ok = await this.patchOrForget(s.id, () =>
          this.client.updateSticky(muralId, entry.widgetId, patch),
        );
        if (!ok) continue; // recreated next pass; don't record state for a dead widget
      }
      entry.text = s.text;
      entry.kind = s.kind;
      entry.confidence = s.confidence;
    }
    for (const h of canvas.hotspots) {
      const entry = ms.widgets[h.id];
      if (!entry || entry.text === h.text) continue;
      const ok = await this.patchOrForget(h.id, () =>
        this.client.updateSticky(muralId, entry.widgetId, { text: stickyText("hotspot", h.text) }),
      );
      if (ok) entry.text = h.text;
    }
  }

  /**
   * Draw sticky links as board connectors, and remove connectors whose link is gone.
   *
   * Keyed in `ms.widgets` like any other widget, so connectors survive a restart and
   * are never re-created for a link that is already drawn. (mcp-mural's own
   * apply_diagram renderer re-issues every connector on every call, which multiplies
   * arrows; going through the id map is what avoids that.)
   */
  private async projectLinks(muralId: string, canvas: Canvas): Promise<void> {
    const ms = this.memory.muralState()!;
    const projected = new Set(Object.keys(ms.widgets));
    const wanted = desiredLinkKeys(canvas, projected);
    const desired = new Map<string, { from: string; to: string; relation: string }>();
    for (const s of canvas.stickies) {
      for (const l of s.links ?? []) {
        const key = linkKey(s.id, l.relation, l.toId);
        if (wanted.has(key)) desired.set(key, { from: s.id, to: l.toId, relation: l.relation });
      }
    }

    for (const key of Object.keys(ms.widgets)) {
      if (!key.startsWith(LINK_PREFIX) || desired.has(key)) continue;
      const entry = ms.widgets[key]!;
      await this.patchOrForget(key, () => this.client.deleteWidget(muralId, entry.widgetId));
      delete ms.widgets[key];
    }

    let created = 0;
    for (const [key, link] of desired) {
      if (ms.widgets[key]) continue;
      // Connector create is single-shot (no batch endpoint), so cap the burst and let
      // the remainder land next pass rather than stalling this one behind N requests.
      if (created >= MAX_NEW_CONNECTORS_PER_PASS) {
        this.dirty = true;
        break;
      }
      const widget = await this.client.createConnector(
        muralId,
        ms.widgets[link.from]!.widgetId,
        ms.widgets[link.to]!.widgetId,
        link.relation,
      );
      ms.widgets[key] = {
        widgetId: widget.id,
        container: LINKS,
        x: 0,
        y: 0,
        text: link.relation,
      };
      created += 1;
    }
    if (created > 0) this.memory.persistMural();
  }

  /**
   * Run a PATCH against a widget we believe exists, healing if it doesn't.
   *
   * A human deleting an agent-created widget in Mural used to wedge projection
   * permanently: the 404 aborted the pass, `lastProjectedRev` never advanced, and
   * every later pass re-diffed the same range onto the same dead id. Forgetting the
   * widget instead lets the normal new-item path recreate it on the next pass.
   *
   * Returns false when the entry was dropped.
   */
  private async patchOrForget(key: string, patch: () => Promise<void>): Promise<boolean> {
    const ms = this.memory.muralState()!;
    try {
      await patch();
      return true;
    } catch (err) {
      if (!(err instanceof MuralApiError) || err.status !== 404) throw err;
      delete ms.widgets[key];
      const container = ms.layout.containers[key.startsWith("area:") ? key.slice(5) : ""];
      if (container) container.areaWidgetId = undefined;
      // Recreation happens on the *next* pass: this one already ran projectNewItems,
      // and the item only looks new once its entry is gone. runPass therefore holds
      // lastProjectedRev back and re-runs, so the same diff range covers it.
      this.healed = true;
      console.warn(`[mural] widget for ${key} is gone from the board; will recreate`);
      return false;
    }
  }

  /** Areas that grew during this pass get one height PATCH each, after placement. */
  private async growAreas(muralId: string, growth: Map<string, number>): Promise<void> {
    const ms = this.memory.muralState()!;
    for (const [containerId, height] of growth) {
      const container = ms.layout.containers[containerId];
      if (!container?.areaWidgetId) continue;
      const widgetId = container.areaWidgetId;
      await this.patchOrForget(`area:${containerId}`, () =>
        this.client.updateArea(muralId, widgetId, { height }),
      );
    }
  }
}

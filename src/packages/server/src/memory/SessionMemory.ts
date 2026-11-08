import type {
  BoundedContextCanvas,
  Canvas,
  ChatMessage,
  Confidence,
  Hint,
  HintStatus,
  Hotspot,
  MuralProjectionState,
  SessionDoc,
  SessionState,
  SessionStatus,
  Sticky,
  StickyKind,
  StickyLink,
  TranscriptChunk,
} from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import type { EventBus } from "../bus/EventBus.ts";
import { NO_SNAPSHOTS, type SnapshotStore } from "./store.ts";

/**
 * The single shared session memory. Both the Synthesizer and the Coach reference the
 * same instance — "common memory" is literally one object in the process.
 *
 * Discipline:
 *  - ingest writes raw inputs (transcript, docs)
 *  - the Synthesizer is the ONLY writer of the canvas (via applyCanvas)
 *  - the Coach only appends to coachChat; it never touches the canvas
 *  - the HintAgent only writes hints (a store beside the canvas, never canvas content)
 */
export class SessionMemory {
  private state: SessionState;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private seqCounter = 0;
  private batching = false;
  private batchDirty = false;
  private readonly snapshots: SnapshotStore;

  /**
   * `snapshots` defaults to NO_SNAPSHOTS, which writes nothing. The server passes a file store,
   * so only the running server persists the session.
   */
  constructor(
    private readonly bus: EventBus,
    opts: { id?: string; title?: string; snapshots?: SnapshotStore } = {},
  ) {
    this.snapshots = opts.snapshots ?? NO_SNAPSHOTS;
    this.state = emptySession(opts.id ?? "demo", opts.title ?? "EventStorming Session");
  }

  getState(): Readonly<SessionState> {
    return this.state;
  }

  /** Replace the whole session state (e.g. restoring a saved snapshot). */
  hydrate(state: SessionState): void {
    state.hints ??= []; // snapshots predating hints
    this.state = state;
    this.seqCounter = state.transcript.reduce((max, c) => Math.max(max, c.seq), 0);
    for (const chunk of state.transcript) this.bus.emit({ type: "transcript.chunk", chunk });
    this.bus.emit({ type: "canvas.updated", canvas: state.canvas, revision: state.revision });
    this.bus.emit({ type: "hints.updated", hints: this.activeHints() });
    this.bus.emit({ type: "session.status", status: state.status });
  }

  /**
   * Reset session to a clean slate without restarting the process.
   * Clears transcript, canvas, mural binding, and hints, then broadcasts the
   * empty state so all connected clients update immediately.
   */
  reset(id = "demo", title = "EventStorming Session"): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.state = emptySession(id, title);
    this.seqCounter = 0;
    this.bus.emit({ type: "canvas.updated", canvas: this.state.canvas, revision: 0 });
    this.bus.emit({ type: "hints.updated", hints: [] });
    this.bus.emit({ type: "session.status", status: "live" });
  }

  // ---- raw inputs (ingest only) -------------------------------------------

  appendChunk(input: { speaker: string; text: string; ts?: string }): TranscriptChunk {
    this.seqCounter += 1;
    const chunk: TranscriptChunk = {
      id: `t-${String(this.seqCounter).padStart(4, "0")}`,
      ts: input.ts ?? new Date().toISOString(),
      speaker: input.speaker,
      text: input.text,
      seq: this.seqCounter,
    };
    this.state.transcript.push(chunk);
    this.bus.emit({ type: "transcript.chunk", chunk });
    this.scheduleSnapshot();
    return chunk;
  }

  upsertDoc(doc: SessionDoc): void {
    const idx = this.state.docs.findIndex((d) => d.id === doc.id);
    if (idx >= 0) this.state.docs[idx] = doc;
    else this.state.docs.push(doc);
    this.scheduleSnapshot();
  }

  // ---- coach channel -------------------------------------------------------

  /** Upserts by id: message ids are unique per reply, so a repeat id (the Coach's rolling
   * provisional assessment) is a refresh in place, not a new message. */
  appendCoachMessage(message: ChatMessage): void {
    const idx = this.state.coachChat.findIndex((m) => m.id === message.id);
    if (idx >= 0) this.state.coachChat[idx] = message;
    else this.state.coachChat.push(message);
    this.scheduleSnapshot();
  }

  // ---- synthesized knowledge (Synthesizer only) ---------------------------

  /** Atomically replace the canvas, bump revision, emit, snapshot. */
  applyCanvas(next: Canvas): void {
    this.state.canvas = next;
    this.commitCanvas();
  }

  /**
   * Apply a batch of canvas upserts as ONE revision with ONE canvas.updated broadcast,
   * instead of a full-canvas event per item. Single-item callers outside a batch keep the
   * per-upsert emit. Returns the number of items applied.
   */
  applyCanvasBatch(items: {
    stickies?: Parameters<SessionMemory["upsertSticky"]>[0][];
    boundedContexts?: Parameters<SessionMemory["upsertBoundedContext"]>[0][];
    hotspots?: Hotspot[];
  }): number {
    let n = 0;
    this.batching = true;
    try {
      for (const s of items.stickies ?? []) {
        this.upsertSticky(s);
        n += 1;
      }
      for (const b of items.boundedContexts ?? []) {
        this.upsertBoundedContext(b);
        n += 1;
      }
      for (const h of items.hotspots ?? []) {
        this.upsertHotspot(h);
        n += 1;
      }
    } finally {
      this.batching = false;
      if (this.batchDirty) {
        this.batchDirty = false;
        this.commitCanvas();
      }
    }
    return n;
  }

  /** Upsert a single sticky by id (keyed merge). Returns the stored sticky. */
  upsertSticky(input: {
    id: string;
    kind: StickyKind;
    text: string;
    confidence?: Confidence;
    sourceChunkIds?: string[];
    order?: number;
    boundedContextId?: string;
    links?: StickyLink[];
  }): Sticky {
    const rev = this.state.revision + 1;
    const stickies = this.state.canvas.stickies;
    const existing = stickies.find((s) => s.id === input.id);
    const sticky: Sticky = {
      id: input.id,
      kind: input.kind,
      text: input.text,
      confidence: input.confidence ?? existing?.confidence ?? "medium",
      sourceChunkIds: input.sourceChunkIds ?? existing?.sourceChunkIds ?? [],
      order: input.order ?? existing?.order,
      boundedContextId: input.boundedContextId ?? existing?.boundedContextId,
      // Links replace wholesale when supplied, so a link the synthesizer drops is
      // really gone (and its board connector gets removed on the next pass).
      links: input.links ?? existing?.links,
      createdAtRev: existing?.createdAtRev ?? rev,
      updatedAtRev: rev,
    };
    if (existing) stickies[stickies.indexOf(existing)] = sticky;
    else stickies.push(sticky);
    this.commitCanvas();
    return sticky;
  }

  /** Upsert a Bounded Context Canvas by id. */
  upsertBoundedContext(
    input: Omit<BoundedContextCanvas, "createdAtRev" | "updatedAtRev">,
  ): BoundedContextCanvas {
    const rev = this.state.revision + 1;
    const list = this.state.canvas.boundedContexts;
    const existing = list.find((b) => b.id === input.id);
    const bc: BoundedContextCanvas = {
      ...input,
      // Deduplicate stickyIds within this BC in case the synthesizer repeated one.
      stickyIds: [...new Set(input.stickyIds)],
      createdAtRev: existing?.createdAtRev ?? rev,
      updatedAtRev: rev,
    };
    if (existing) list[list.indexOf(existing)] = bc;
    else list.push(bc);

    // Keep sticky.boundedContextId in sync with this BC's stickyIds so the layout
    // engine (containerFor) and the Mural projector place stickies in the right area.
    const newIds = new Set(bc.stickyIds);
    const stickies = this.state.canvas.stickies;
    for (let i = 0; i < stickies.length; i++) {
      const s = stickies[i]!;
      if (newIds.has(s.id) && s.boundedContextId !== input.id) {
        stickies[i] = { ...s, boundedContextId: input.id, updatedAtRev: rev };
      } else if (!newIds.has(s.id) && s.boundedContextId === input.id) {
        stickies[i] = { ...s, boundedContextId: undefined, updatedAtRev: rev };
      }
    }

    // Remove unplaced duplicates: stickies that share kind+text with a sticky now
    // assigned to this BC but have no boundedContextId (the synthesizer created two
    // copies — one placed, one floating). Splice in reverse order to keep indices valid.
    const placedKeys = new Set(
      stickies
        .filter((s) => s.boundedContextId === input.id)
        .map((s) => `${s.kind}:${s.text.trim().toLowerCase()}`),
    );
    const toRemove: number[] = [];
    for (let i = 0; i < stickies.length; i++) {
      const s = stickies[i]!;
      if (!s.boundedContextId && placedKeys.has(`${s.kind}:${s.text.trim().toLowerCase()}`)) {
        toRemove.push(i);
      }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) {
      stickies.splice(toRemove[i]!, 1);
    }

    this.commitCanvas();
    return bc;
  }

  /** Upsert a top-level hotspot by id. Skips creation if an existing hotspot has the
   * same text (case-insensitive) to prevent the synthesizer from filing the same concern twice. */
  upsertHotspot(input: Hotspot): Hotspot {
    const list = this.state.canvas.hotspots;
    const byId = list.find((h) => h.id === input.id);
    if (byId) {
      list[list.indexOf(byId)] = input;
      this.commitCanvas();
      return input;
    }
    const normalizedText = input.text.trim().toLowerCase();
    const byText = list.find((h) => h.text.trim().toLowerCase() === normalizedText);
    if (byText) return byText; // duplicate text — return existing, no canvas change
    list.push(input);
    this.commitCanvas();
    return input;
  }

  setLastSynthesizedSeq(seq: number): void {
    this.state.lastSynthesizedSeq = seq;
  }

  private commitCanvas(): void {
    if (this.batching) {
      // Inside applyCanvasBatch: defer the revision bump + broadcast to the end of the batch.
      this.batchDirty = true;
      return;
    }
    this.state.revision += 1;
    this.state.canvas.lastUpdatedRev = this.state.revision;
    this.bus.emit({
      type: "canvas.updated",
      canvas: this.state.canvas,
      revision: this.state.revision,
    });
    this.pruneStaleHints();
    this.scheduleSnapshot();
  }

  // ---- coach hints (HintAgent + engage/dismiss routes) --------------------

  activeHints(): Hint[] {
    return this.state.hints.filter((h) => h.status === "active");
  }

  getHint(id: string): Hint | undefined {
    return this.state.hints.find((h) => h.id === id);
  }

  /** Hints the facilitator dismissed — fed back to generation so topics aren't re-suggested. */
  dismissedHints(): Hint[] {
    return this.state.hints.filter((h) => h.status === "dismissed");
  }

  /**
   * Upsert a hint by id. New hints beyond the active cap are dropped (returns null);
   * dismissed/engaged ids are never resurrected.
   */
  upsertHint(
    input: Omit<Hint, "status" | "createdTs">,
    maxActive: number,
  ): Hint | null {
    const existing = this.state.hints.find((h) => h.id === input.id);
    if (existing && existing.status !== "active") return null;
    if (!existing && this.activeHints().length >= maxActive) return null;
    const hint: Hint = {
      ...input,
      status: "active",
      createdTs: existing?.createdTs ?? new Date().toISOString(),
    };
    if (existing) this.state.hints[this.state.hints.indexOf(existing)] = hint;
    else this.state.hints.push(hint);
    this.commitHints();
    return hint;
  }

  /** Transition an active hint to engaged/dismissed. Returns false if not active. */
  setHintStatus(id: string, status: Exclude<HintStatus, "active">): boolean {
    const hint = this.state.hints.find((h) => h.id === id);
    if (!hint || hint.status !== "active") return false;
    hint.status = status;
    this.commitHints();
    return true;
  }

  /** Drop active hints whose target element left the canvas (runs on every canvas commit). */
  private pruneStaleHints(): void {
    const ids = new Set<string>([
      ...this.state.canvas.stickies.map((s) => s.id),
      ...this.state.canvas.boundedContexts.map((b) => b.id),
      ...this.state.canvas.hotspots.map((h) => h.id),
    ]);
    const before = this.state.hints.length;
    this.state.hints = this.state.hints.filter(
      (h) => h.status !== "active" || !h.targetId || ids.has(h.targetId),
    );
    if (this.state.hints.length !== before) this.commitHints();
  }

  private commitHints(): void {
    this.bus.emit({ type: "hints.updated", hints: this.activeHints() });
    this.scheduleSnapshot();
  }

  get revision(): number {
    return this.state.revision;
  }

  // ---- mural projection (MuralProjector only) ------------------------------

  muralState(): MuralProjectionState | undefined {
    return this.state.mural;
  }

  /**
   * Bind/reset the mural projection state (undefined = unbind). Schedules a save unless `save`
   * is false. The startup restore passes false, because a save then would write the empty
   * startup session over the snapshot the binding came from.
   */
  setMuralState(mural: MuralProjectionState | undefined, opts: { save?: boolean } = {}): void {
    this.state.mural = mural;
    if (opts.save !== false) this.scheduleSnapshot();
  }

  /** The projector mutates its state object in place; this persists it. */
  persistMural(): void {
    this.scheduleSnapshot();
  }

  // ---- bookkeeping ---------------------------------------------------------

  lastSeq(): number {
    return this.seqCounter;
  }

  /** Transcript chunks not yet seen by the Synthesizer (seq > since). */
  unprocessedSince(since: number): TranscriptChunk[] {
    return this.state.transcript.filter((c) => c.seq > since);
  }

  setStatus(status: SessionStatus): void {
    this.state.status = status;
    this.bus.emit({ type: "session.status", status });
    this.scheduleSnapshot();
  }

  // ---- persistence (debounced) --------------------------------------------

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.snapshots.save(this.state).catch(() => {
        /* best-effort snapshot */
      });
    }, 500);
  }
}

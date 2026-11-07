import type { Canvas, ServerEvent, TranscriptChunk } from "@specstorming/shared";
import type { EventBus } from "../bus/EventBus.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";
import { AGENTS } from "../config.ts";
import { withSpan } from "../observability/tracing.ts";
import { CANVAS_TOOL_NAMES, createCanvasTools } from "./tools/canvasTools.ts";
import { loadSteering, runAgentDirect } from "./runner.ts";

const ROLE = `You are the Synthesizer agent in a live EventStorming session. You silently watch
the meeting transcript and continuously build a read-only Canvas that captures the emerging
model. You never speak to participants; you only update the Canvas via your tools.`;

const TRIGGER_CHUNKS = 3; // run once this many new chunks have accumulated
const MAX_WAIT_MS = 5_000; // …or this long has passed with at least one new chunk
const MAX_WINDOW = 12; // chunks per window — small enough that a pass lands inside PASS_TIMEOUT_MS
/**
 * Most windows dispatched concurrently in one batch. The backlog is deliberately NOT drained in
 * a single batch: replay emits a chunk every 200ms, so the whole transcript lands while the first
 * pass is still running, and splitting that entire backlog into simultaneous windows spawns one
 * Agent SDK subprocess each — they then contend and miss the timeout together. Whatever doesn't
 * fit stays in the backlog and the next batch picks it up.
 */
const MAX_PARALLEL_WINDOWS = 3;
const PASS_TIMEOUT_MS = 180_000; // wall-clock safety net per synthesis pass
/** Delay before retrying a batch that made no progress, so a persistent failure can't hot-loop. */
const RETRY_BACKOFF_MS = 2_000;
/** Consecutive no-progress batches before the head window is skipped so the session moves on. */
const MAX_BATCH_ATTEMPTS = 3;

/** Compact view of the current canvas so the model can do incremental upserts by id. */
function summarizeCanvas(canvas: Canvas): string {
  const stickies = canvas.stickies
    .map((s) => {
      // Only stickies that already have flow edges pay for the extra tokens.
      const links = s.links?.length
        ? ` → ${s.links.map((l) => `${l.relation}:${l.toId}`).join(", ")}`
        : "";
      return `${s.id} [${s.kind}] ${s.text}${links}`;
    })
    .join("\n");
  const bcs = canvas.boundedContexts
    .map((b) => `${b.id} (${b.strategicClassification.domain}): ${b.name}`)
    .join("\n");
  const hotspots = canvas.hotspots.map((h) => `${h.id}: ${h.text}`).join("\n");
  return [
    `STICKIES (${canvas.stickies.length}):\n${stickies || "(none yet)"}`,
    `BOUNDED CONTEXTS (${canvas.boundedContexts.length}):\n${bcs || "(none yet)"}`,
    `HOTSPOTS (${canvas.hotspots.length}):\n${hotspots || "(none yet)"}`,
  ].join("\n\n");
}

function formatWindow(chunks: TranscriptChunk[]): string {
  return chunks.map((c) => `[${c.id}] ${c.speaker}: ${c.text}`).join("\n");
}

/**
 * How far the synthesized-through watermark may move after a batch: to the end of the longest
 * LEADING run of windows that succeeded. Stopping at the first failure is what keeps a failed
 * window's chunks in the backlog — advancing past one silently drops those chunks forever, which
 * leaves the canvas frozen while lastSynthesizedSeq claims the transcript was fully covered.
 * A later window that succeeded behind a failed one is simply redone next batch; canvas writes
 * are id-keyed upserts, so replaying a window is harmless.
 */
export function watermarkAfterBatch(
  windows: TranscriptChunk[][],
  succeeded: boolean[],
  current: number,
): number {
  let advanceTo = current;
  for (let i = 0; i < windows.length && succeeded[i]; i++) {
    advanceTo = windows[i][windows[i].length - 1].seq;
  }
  return advanceTo;
}

/**
 * Watches the transcript and, on a debounce, dispatches the entire unprocessed backlog as
 * parallel LLM windows (each MAX_WINDOW chunks). All windows start from the same canvas
 * snapshot so they don't block each other; canvas tool calls are synchronous in the Node.js
 * event loop so concurrent updates are safe without extra locking. Mural writes remain
 * sequential via MuralProjector's running/dirty coalescing — no extra coordination needed.
 */
export class SynthesizerAgent {
  private systemPrompt = "";
  private groupingSystemPrompt = "";

  private running = false;
  private dirty = false;
  private suspended = false;
  private newChunks = 0;
  private lastProcessedSeq = 0;
  /** Batches in a row that advanced no chunks; drives backoff and the skip-ahead escape hatch. */
  private consecutiveFailures = 0;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private batchAbort: AbortController | null = null;

  constructor(
    private readonly memory: SessionMemory,
    private readonly bus: EventBus,
  ) {}

  async init(): Promise<void> {
    const [stickySteering, groupingSteering] = await Promise.all([
      loadSteering([...AGENTS.synthesizer.steering]),
      loadSteering(["ddd"]),
    ]);
    this.systemPrompt = `${ROLE}\n\n${stickySteering}`;
    this.groupingSystemPrompt = `${ROLE}\n\n${groupingSteering}`;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((e: ServerEvent) => {
      if (e.type === "transcript.chunk") this.onChunk();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.waitTimer) clearTimeout(this.waitTimer);
  }

  /** Force a synthesis pass now (e.g. when the session finishes). */
  flush(): void {
    void this.runOnce();
  }

  /** Cancel all in-flight LLM windows immediately. Safe to call at any time. */
  abort(): void {
    if (this.batchAbort) {
      this.batchAbort.abort();
      this.batchAbort = null;
    }
    this.running = false;
    this.dirty = false;
    this.newChunks = 0;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  /** Reset synthesizer to initial state (call after session reset). */
  resetState(): void {
    this.abort();
    this.lastProcessedSeq = 0;
    this.consecutiveFailures = 0;
    this.suspended = false;
  }

  /**
   * Stop starting new passes without cancelling in-flight windows or discarding backlog.
   * Sits between abort() (which cancels in flight) and suspendCaughtUp() (which throws the
   * backlog away): used when the spec pipeline takes over the session, so the current batch
   * lands normally but nothing new begins.
   */
  suspend(): void {
    this.suspended = true;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  /** Stop reacting to transcript and treat everything as already synthesized (e.g. after
   * hydrating a finished session whose Canvas is already complete). */
  suspendCaughtUp(): void {
    this.suspended = true;
    this.lastProcessedSeq = this.memory.lastSeq();
    this.newChunks = 0;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  /** Undo suspendCaughtUp (e.g. when a replay starts on a hydrated session). Only
   * chunks newer than the suspend point are synthesized — no double processing. */
  resume(): void {
    this.suspended = false;
  }

  /** Forget everything about the previous session so a reset replay starts from seq 0. */
  reset(): void {
    this.suspended = false;
    this.dirty = false;
    this.newChunks = 0;
    this.lastProcessedSeq = 0;
    this.consecutiveFailures = 0;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  private onChunk(): void {
    if (this.suspended) return;
    this.newChunks += 1;
    if (this.newChunks >= TRIGGER_CHUNKS) {
      void this.runOnce();
      return;
    }
    if (!this.waitTimer) {
      this.waitTimer = setTimeout(() => void this.runOnce(), MAX_WAIT_MS);
    }
  }

  private async runOnce(): Promise<void> {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    // Checked here as well as in onChunk(), because the finally block below self re-arms:
    // without this, suspending mid-batch would still start one more pass once that batch
    // landed. Also makes flush() a no-op while suspended, which is what callers want.
    if (this.suspended) return;
    if (this.running) {
      this.dirty = true;
      return;
    }

    const backlog = this.memory.unprocessedSince(this.lastProcessedSeq);
    if (backlog.length === 0) return;

    // Take at most MAX_PARALLEL_WINDOWS windows of MAX_WINDOW chunks and dispatch them in
    // parallel; the rest of the backlog waits for the next batch. Each window gets the same
    // canvas snapshot as context so none blocks another. Canvas tool calls (update_canvas) are
    // synchronous in the Node.js event loop — no mutex needed. Mural writes are kept sequential
    // by MuralProjector's running/dirty coalescing, which is the ordering gate for board writes.
    const windows: TranscriptChunk[][] = [];
    for (let i = 0; i < backlog.length && windows.length < MAX_PARALLEL_WINDOWS; i += MAX_WINDOW) {
      windows.push(backlog.slice(i, i + MAX_WINDOW));
    }
    const deferred = backlog.length - windows.reduce((n, w) => n + w.length, 0);

    this.running = true;
    this.newChunks = 0;
    this.batchAbort = new AbortController();
    const { signal } = this.batchAbort;
    const canvasSnapshot = summarizeCanvas(this.memory.getState().canvas);
    const batchEndSeq = windows[windows.length - 1][windows[windows.length - 1].length - 1].seq;
    console.log(
      `[synthesizer] batch start — ${windows.length} parallel window(s), seqs ${backlog[0].seq}–${batchEndSeq}` +
        (deferred > 0 ? ` (${deferred} chunk(s) deferred to the next batch)` : ""),
    );

    try {
      const succeeded = await Promise.all(
        windows.map((win, idx) => {
          const seqStart = win[0].seq;
          const seqEnd = win[win.length - 1].seq;
          const total = windows.length;

          const prompt = [
            "Here is the current Canvas you have built so far:",
            "",
            canvasSnapshot,
            "",
            `Here are the NEW transcript lines (batch ${idx + 1} of ${total}, chunks ${seqStart}–${seqEnd}):`,
            "",
            formatWindow(win),
            "",
            "Call update_canvas ONCE with all changes these new lines imply:",
            "- new stickies for concepts that genuinely appear here (events past-tense, commands, actors, policies, read models, external systems, aggregates);",
            "- reuse an existing sticky's id when these lines refine it (do NOT duplicate or restate the whole board);",
            "- hotspots for any disagreement, ambiguity, or open question raised here;",
            "- create or refine a Bounded Context Canvas when these lines make a context clear.",
            "Set `order` on each sticky to its place in the business-process sequence (space values by 10).",
            "Set `links` where these lines make a flow explicit (command triggers event, policy invokes command) — only for pairs actually stated.",
            "Cite the relevant [t-xxxx] ids in sourceChunkIds. Be selective and precise.",
          ].join("\n");

          // Fresh MCP server per window — reusing one SDK MCP instance across query() calls hangs.
          const canvasServer = createCanvasTools(this.memory);
          console.log(`[synthesizer] window ${idx + 1}/${total} start — ${win.length} chunks, seqs ${seqStart}–${seqEnd}`);

          return withSpan(
            "synthesizer.pass",
            {
              sessionId: this.memory.getState().id,
              metadata: { window: String(win.length), throughSeq: String(seqEnd), batchIdx: String(idx) },
            },
            () =>
              runAgentDirect({
                agent: "synthesizer",
                label: "synthesizer",
                traceMetadata: { window: String(win.length), batchIdx: String(idx) },
                systemPrompt: this.systemPrompt,
                prompt,
                timeoutMs: PASS_TIMEOUT_MS,
                signal,
                options: {
                  model: AGENTS.synthesizer.model,
                  mcpServers: { canvas: canvasServer },
                  allowedTools: CANVAS_TOOL_NAMES,
                  maxTurns: 3,
                  maxBudgetUsd: 1.0,
                  thinking: { type: "disabled" },
                },
              }),
          ).then((result) => {
            if (result.isError) {
              // Never silent: a window that dies here is chunks that did NOT reach the canvas.
              console.error(
                `[synthesizer] window ${idx + 1}/${total} (seqs ${seqStart}–${seqEnd}) failed — ${result.errorDetail ?? "unknown error"}; chunks stay queued for retry`,
              );
              return false;
            }
            const canvas = this.memory.getState().canvas;
            console.log(`[synthesizer] window ${idx + 1}/${total} done — ${canvas.stickies.length} stickies, ${canvas.boundedContexts.length} BCs, ${canvas.hotspots.length} hotspots`);
            return true;
          });
        }),
      );

      const advanceTo = watermarkAfterBatch(windows, succeeded, this.lastProcessedSeq);

      if (advanceTo > this.lastProcessedSeq) {
        this.lastProcessedSeq = advanceTo;
        this.memory.setLastSynthesizedSeq(advanceTo);
        this.consecutiveFailures = 0;
        await this.runGroupingPass(signal);
      } else if (!signal.aborted) {
        this.consecutiveFailures += 1;
        const head = windows[0];
        const headEnd = head[head.length - 1].seq;
        if (this.consecutiveFailures >= MAX_BATCH_ATTEMPTS) {
          // The head window fails every time (too large, or a persistently failing model call).
          // Skip it so the rest of the transcript still gets synthesized, and say so loudly.
          console.error(
            `[synthesizer] seqs ${head[0].seq}–${headEnd} failed ${this.consecutiveFailures}× — skipping them so the backlog can drain`,
          );
          this.lastProcessedSeq = headEnd;
          this.memory.setLastSynthesizedSeq(headEnd);
          this.consecutiveFailures = 0;
        } else {
          console.error(
            `[synthesizer] batch made no progress (attempt ${this.consecutiveFailures}/${MAX_BATCH_ATTEMPTS}) — retrying seqs ${head[0].seq}–${headEnd}`,
          );
        }
      }
    } catch (err) {
      console.error("[synthesizer] batch failed:", err);
      console.error("[synthesizer] error detail:", err instanceof Error ? err.stack : String(err));
    } finally {
      this.batchAbort = null;
      this.running = false;
      const hasBacklog =
        this.dirty || this.memory.unprocessedSince(this.lastProcessedSeq).length > 0;
      this.dirty = false;
      // A cancelled batch (finish/reset/pipeline handover) must not re-arm itself, or abort()
      // can never actually stop the loop.
      if (hasBacklog && !this.suspended && !signal.aborted) {
        if (this.consecutiveFailures > 0) {
          // Back off so a batch that keeps failing can't spin the event loop.
          if (this.waitTimer) clearTimeout(this.waitTimer);
          this.waitTimer = setTimeout(() => void this.runOnce(), RETRY_BACKOFF_MS);
        } else {
          void this.runOnce();
        }
      }
    }
  }

  private async runGroupingPass(signal: AbortSignal): Promise<void> {
    const canvas = this.memory.getState().canvas;
    if (canvas.stickies.length === 0) return;

    const stickyList = canvas.stickies
      .map((s) => `${s.id} [${s.kind}] ${s.text}`)
      .join("\n");

    const existingBCs = canvas.boundedContexts
      .map((b) => `${b.id} (${b.strategicClassification.domain}): ${b.name} — stickyIds: [${(b.stickyIds ?? []).join(", ")}]`)
      .join("\n");

    const prompt = [
      "Here are all the stickies currently on the Canvas:",
      "",
      stickyList,
      "",
      existingBCs
        ? `Existing Bounded Contexts (refine or add to these):\n${existingBCs}\n`
        : "",
      "Group these stickies into Bounded Contexts by calling update_canvas with a boundedContexts array.",
      "- Each BoundedContext MUST include stickyIds listing every sticky that belongs to it.",
      "- Cluster by linguistic and responsibility cohesion — events/commands that share language and change together belong together.",
      "- Classify each context's domain: core / supporting / generic.",
      "- Reuse an existing boundedContext id to refine it; invent a new kebab-case id for new ones.",
      "- Leave stickies and hotspots arrays empty — only update boundedContexts.",
    ].join("\n");

    const canvasServer = createCanvasTools(this.memory);
    console.log(`[synthesizer] grouping pass — ${canvas.stickies.length} stickies → bounded contexts`);

    try {
      const result = await runAgentDirect({
        agent: "synthesizer",
        label: "synthesizer-grouping",
        traceMetadata: { phase: "grouping" },
        systemPrompt: this.groupingSystemPrompt,
        prompt,
        timeoutMs: PASS_TIMEOUT_MS,
        signal,
        options: {
          model: AGENTS.synthesizer.model,
          mcpServers: { canvas: canvasServer },
          allowedTools: CANVAS_TOOL_NAMES,
          maxTurns: 3,
          maxBudgetUsd: 1.0,
          thinking: { type: "disabled" },
        },
      });
      if (result.isError) {
        console.error("[synthesizer] grouping pass errored");
      } else {
        const updated = this.memory.getState().canvas;
        console.log(`[synthesizer] grouping pass done — ${updated.boundedContexts.length} bounded contexts`);
      }
    } catch (err) {
      console.error("[synthesizer] grouping pass failed:", err);
    }
  }
}

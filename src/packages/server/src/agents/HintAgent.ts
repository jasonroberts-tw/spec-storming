import type { Canvas, Hint, ServerEvent, SessionState } from "@specstorming/shared";
import type { EventBus } from "../bus/EventBus.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";
import { AGENTS, HINTS_CONFIG } from "../config.ts";
import { withSpan } from "../observability/tracing.ts";
import { createHintTools, HINT_TOOL_NAMES } from "./tools/hintTools.ts";
import { loadSteering, runAgent } from "./runner.ts";

const ROLE = `You are the Coach in a live EventStorming session, in your proactive role: you
quietly watch the workshop and occasionally offer an unprompted hint — a nudge the facilitator
can pick up or dismiss. You have exactly five kinds of hint:

- discuss-hotspot: an unresolved hotspot on the canvas deserves the room's attention now
- clarify-ambiguity: a term or flow is being used with different meanings by different people
- go-broader: a whole area of the domain hasn't been touched and plausibly matters
- go-deeper: an area is modeled too thinly (e.g. a bounded context with almost no stickies)
- next-topic: a concrete, well-motivated suggestion for what to talk about next

THE DEFAULT IS SILENCE. Most passes should suggest NOTHING — call suggest_hints with an empty
list (or not at all) unless a hint is genuinely worth interrupting the room for. Never restate
what the group is already discussing, never re-suggest a dismissed topic, and never duplicate
an active hint. Each hint needs: a stable kebab-case id; one short imperative sentence of text;
a pre-authored engagement prompt containing the concrete target text and why it matters (the
coach conversation is seeded with this verbatim); the targetId of the sticky/hotspot/context it
concerns when applicable; and the [t-xxxx] source chunk ids that motivated it.`;

const PASS_TIMEOUT_MS = 60_000;
const TRANSCRIPT_WINDOW = 20; // recent lines shown to the model per pass

function summarizeCanvas(canvas: Canvas): string {
  const stickies = canvas.stickies.map((s) => `${s.id} [${s.kind}] ${s.text}`).join("\n");
  const bcs = canvas.boundedContexts
    .map((b) => `${b.id} (${b.strategicClassification.domain}): ${b.name} — ${b.stickyIds.length} stickies`)
    .join("\n");
  const hotspots = canvas.hotspots.map((h) => `${h.id}: ${h.text}`).join("\n");
  return [
    `STICKIES (${canvas.stickies.length}):\n${stickies || "(none yet)"}`,
    `BOUNDED CONTEXTS (${canvas.boundedContexts.length}):\n${bcs || "(none yet)"}`,
    `HOTSPOTS (${canvas.hotspots.length}):\n${hotspots || "(none yet)"}`,
  ].join("\n\n");
}

function summarizeHints(label: string, hints: Hint[]): string {
  const lines = hints.map((h) => `${h.id} [${h.kind}] ${h.text}`).join("\n");
  return `${label} (${hints.length}):\n${lines || "(none)"}`;
}

function recentTranscript(state: SessionState): string {
  return state.transcript
    .slice(-TRANSCRIPT_WINDOW)
    .map((c) => `[${c.id}] ${c.speaker}: ${c.text}`)
    .join("\n");
}

/**
 * Background hint generation, modeled on the Synthesizer's debounced pass pattern but far
 * less frequent: hints should be occasional. A pass runs only after a quiet debounce, past a
 * minimum interval, when cheap preconditions hold (canvas content exists, chunks arrived,
 * room under the active cap). The pass is submitted at hint priority: the scheduler runs it
 * only when no synthesis/coach/pipeline work is pending, so hints defer rather than being
 * silently dropped, and a newer pass replaces a still-queued one (replaceKey).
 */
export class HintAgent {
  private systemPrompt = "";

  private running = false;
  private suspended = false;
  private lastPassAt = 0;
  private lastPassSeq = 0;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly memory: SessionMemory,
    private readonly bus: EventBus,
  ) {}

  async init(): Promise<void> {
    const steering = await loadSteering([...AGENTS.hints.steering]);
    this.systemPrompt = `${ROLE}\n\n${steering}`;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((e: ServerEvent) => {
      if (e.type === "transcript.chunk" || e.type === "canvas.updated") this.onActivity();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  /** Stop proposing hints (e.g. hydrated finished session — nothing left to facilitate). */
  suspend(): void {
    this.suspended = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  /** Undo suspend when the session becomes live again (e.g. a replay starts). */
  resume(): void {
    this.suspended = false;
  }

  /** Forget the previous session's pass history so a reset replay is nudged from scratch. */
  reset(): void {
    this.suspended = false;
    this.lastPassAt = 0;
    this.lastPassSeq = 0;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  private onActivity(): void {
    if (this.suspended || this.waitTimer) return;
    // Arm once (not trailing): under continuous conversation a trailing debounce would
    // starve forever; this gives a periodic attempt, throttled further by minIntervalMs.
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      void this.runOnce();
    }, HINTS_CONFIG.debounceMs);
  }

  private shouldRun(): boolean {
    const state = this.memory.getState();
    if (Date.now() - this.lastPassAt < HINTS_CONFIG.minIntervalMs) return false;
    if (state.canvas.lastUpdatedRev === 0) return false; // cold start: wait for synthesis
    if (this.memory.activeHints().length >= HINTS_CONFIG.maxActive) return false;
    if (this.memory.lastSeq() - this.lastPassSeq < HINTS_CONFIG.minNewChunks) return false;
    return true;
  }

  private async runOnce(): Promise<void> {
    // `suspended` is checked here too, not just in onActivity(), so a timer callback already
    // dispatched when suspend() ran cannot slip a pass through.
    if (this.suspended || this.running || !this.shouldRun()) return;
    this.running = true;
    this.lastPassAt = Date.now();
    this.lastPassSeq = this.memory.lastSeq();

    const state = this.memory.getState();
    const prompt = [
      "Current canvas:",
      "",
      summarizeCanvas(state.canvas),
      "",
      summarizeHints("ACTIVE HINTS (do not duplicate)", this.memory.activeHints()),
      "",
      summarizeHints("DISMISSED HINTS (never re-suggest these topics)", this.memory.dismissedHints()),
      "",
      `RECENT TRANSCRIPT (last ${TRANSCRIPT_WINDOW} lines):`,
      recentTranscript(state) || "(empty)",
      "",
      "If — and only if — something here is genuinely worth an unprompted nudge, call",
      "suggest_hints ONCE with at most 2 hints. Otherwise suggest nothing.",
    ].join("\n");

    // Fresh MCP server per pass — reusing one SDK MCP instance across query() calls hangs.
    const hintServer = createHintTools(this.memory);

    try {
      const result = await withSpan(
        "hints.pass",
        {
          sessionId: state.id,
          metadata: { throughSeq: String(this.lastPassSeq) },
        },
        () =>
          runAgent({
            agent: "hints",
            replaceKey: "hints", // at most one hint pass ever waits in the queue
            label: "hints",
            systemPrompt: this.systemPrompt,
            prompt,
            timeoutMs: PASS_TIMEOUT_MS,
            options: {
              model: AGENTS.hints.model,
              mcpServers: { hints: hintServer },
              allowedTools: HINT_TOOL_NAMES,
              maxTurns: 4,
              // Was 0.25, which no pass ever survived. Two compounding causes, both measured
              // against the finished demo canvas (78 stickies / 7 BCs / 18 hotspots): adaptive
              // thinking (below) cost $0.2309 of the $0.25 on its own, and a pass that suggests
              // a hint then keeps working through its remaining turns still exceeded 0.25 with
              // thinking off. A failure here is silent to the room — the hint is simply never
              // delivered — so leave real headroom rather than trimming to the last observation.
              maxBudgetUsd: 0.5,
              effort: "low", // judgment call over a small context — no extended thinking
              // Sonnet 5 runs adaptive thinking unless told otherwise, and `effort` alone does
              // not turn it off. Disabling it took a representative pass from $0.2309 to
              // $0.0348. The Synthesizer disables thinking for the same reason.
              thinking: { type: "disabled" },
            },
          }),
      );
      if (result.isError) console.error("[hints] pass aborted or errored");
    } catch (err) {
      console.error("[hints] pass failed:", err);
    } finally {
      this.running = false;
    }
  }
}

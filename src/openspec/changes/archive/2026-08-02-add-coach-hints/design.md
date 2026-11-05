# Design: Add Coach Hints

## Context

The system is a real-time EventStorming workshop tool: a Fastify server holds a single in-memory `SessionMemory`, agents run via the Claude Agent SDK, and all state flows to the React UI over one SSE stream (`/api/stream`) as `ServerEvent` objects. Two agents exist today:

- **Synthesizer** (`packages/server/src/agents/SynthesizerAgent.ts`): debounced background passes over transcript windows; sole writer of the canvas via the batch `update_canvas` MCP tool.
- **Coach** (`packages/server/src/agents/CoachAgent.ts`): user-triggered Q&A, streams text deltas, never writes the canvas.

Hints add a third behavior: *unprompted* guidance ("discuss this hot spot", "clarify this term", "go broader/deeper", "talk about X next") surfaced on the canvas and engageable in coach chat. Constraints: keep the synthesizer's canvas write-exclusivity, keep agent latency/cost bounded (global query lock serializes all SDK queries), and stay within the existing SSE + reducer data flow.

## Goals / Non-Goals

**Goals:**
- Proactive hint generation from workshop state (transcript, canvas, chat), rate-limited and deduplicated.
- Hints visible on the canvas with distinct, lightweight styling; anchorable to the sticky/hotspot/bounded context they concern.
- One-click engagement: a hint becomes a seeded coach conversation; hints can be dismissed.
- Hints persist in session snapshots and replay to late-joining clients.

**Non-Goals:**
- Hints do not modify the canvas model (no sticky/BC/hotspot writes).
- No per-user hint targeting — all clients see the same hints (matches the shared-session model).
- No hint history UI beyond active hints (engaged/dismissed hints just leave the canvas).
- No spoken/audio delivery; hints are visual only.

## Decisions

### 1. A dedicated `HintAgent`, modeled on the Synthesizer's pass pattern

**Decision:** Add `packages/server/src/agents/HintAgent.ts` — a debounced background agent that runs a per-pass `query()` (fresh MCP server each pass, effort `low`, timeout ~60s, small budget) and emits hints via a single batch MCP tool `suggest_hints`.

**Why:** The per-pass pattern is proven here (persistent streaming sessions stalled; per-pass with `effort: 'low'` is fast and reliable — see synthesizer memory notes). Reusing `CoachAgent` for generation would couple user-triggered Q&A latency to background passes and complicate its "text-only, no tools" contract. A separate agent keeps both contracts clean: Coach = reactive text, Synthesizer = canvas writes, HintAgent = hint writes.

**Alternatives considered:** (a) Synthesizer emits hints in its `update_canvas` call — rejected: overloads its prompt with a second job, and hint cadence (occasional) differs from synthesis cadence (every ~6 chunks). (b) Pure heuristics without an LLM (e.g. "hotspot older than N revisions → hint") — rejected as primary mechanism because "clarify ambiguity" and "go deeper" need judgment, but cheap heuristics DO gate when a pass runs (see decision 3).

### 2. Hints live in `SessionState.hints`, not inside `Canvas`

**Decision:** New top-level `hints: Hint[]` on `SessionState` with `upsertHint()` / `setHintStatus()` on `SessionMemory`. `Hint` (in `packages/shared/src/canvas.ts` or a new `hints.ts`):

```typescript
type HintKind = "discuss-hotspot" | "clarify-ambiguity" | "go-broader" | "go-deeper" | "next-topic";
type HintStatus = "active" | "engaged" | "dismissed";
interface Hint {
  id: string;            // kebab-case, stable for dedupe
  kind: HintKind;
  text: string;          // short imperative guidance shown on canvas
  prompt: string;        // seed text used when engaged in coach chat
  targetId?: string;     // sticky / hotspot / bounded-context id it concerns
  sourceChunkIds?: string[];
  status: HintStatus;
  createdTs: string;     // ISO
}
```

**Why:** `Canvas` is the synthesizer's exclusive write territory; putting hints beside it (like `coachChat`) preserves that invariant with zero locking questions. Hints still render *on* the canvas in the UI — storage location and display location are independent.

**Alternatives:** `hints` inside `Canvas` (rejected: breaks write-exclusivity), or a new `StickyKind: "hint"` (rejected: hints have lifecycle/engagement semantics stickies don't, and would pollute timeline ordering).

### 3. Trigger: heuristic gate + debounce, hard rate limit

**Decision:** The HintAgent listens to the same activity signals as the synthesizer (new transcript chunks, canvas revisions) but runs far less often: debounce ~30s after activity, minimum ~60s between passes, and skip the pass entirely unless a cheap precondition holds (e.g. an undiscussed hotspot exists, a bounded context has few stickies, or N chunks arrived since the last hint). At most 3 `active` hints at a time; the agent's prompt includes current active/dismissed hints and instructs it to return **zero hints** when nothing is genuinely useful — silence is the default.

**Why:** Unprompted guidance is only valuable when rare. Rate limiting server-side (not prompt-side alone) guarantees the UX and bounds cost. Dismissed hint ids are kept for the session and fed back to the agent so dismissed topics aren't re-suggested.

### 4. Events and API follow existing conventions

**Decision:**
- New `ServerEvent` variants: `{ type: "hints.updated"; hints: Hint[] }` (full active-list replace, like `canvas.updated`) — one event covers create, engage, dismiss, and expiry. SSE catch-up replays current hints on connect.
- New routes: `POST /api/hint/:id/engage` and `POST /api/hint/:id/dismiss`. Engage marks the hint `engaged`, appends a user-role chat message derived from the hint (so the exchange is visible in history), and invokes `coach.ask()` with the hint's `prompt` plus its target's canvas context; the coach reply then streams over the existing `coach.delta` / `coach.done` events unchanged.

**Why:** Full-list replace mirrors the `canvas.updated` pattern the client reducer already handles well, avoiding per-hint diff events. Routing engagement through the existing coach path means zero changes to chat streaming.

### 5. UI: hint chips on the canvas, engagement in `CoachChat`

**Decision:** A `HintChip` component rendered in a distinct strip on the canvas (visually lighter than stickies — outlined/tinted chip with a kind icon, not a sticky note). Hovering a hint with a `targetId` highlights the target element. Each chip has Engage (opens/focuses coach chat, fires engage route) and Dismiss actions. `useSessionStream.ts` gains a `hints` array driven by `hints.updated`.

**Why:** Hints are meta-guidance about the model, not part of the model; the visual hierarchy should say so. Reusing the chat panel for engagement (rather than a hint-specific popover conversation) keeps one conversation surface.

## Risks / Trade-offs

- [Hint noise annoys facilitators] → Hard cap of 3 active hints, ≥60s between passes, "return zero hints" as the instructed default, dismissed-topic feedback, one-click dismiss.
- [Global query lock contention: hint passes delay synthesis or coach answers] → HintAgent acquires the lock last-priority (skips its pass if the lock is busy rather than queueing), low effort, short timeout.
- [Duplicate or stale hints (e.g. hotspot already resolved)] → Stable kebab-case ids for dedupe; each pass receives current canvas + active hints and is instructed to drop hints whose target no longer exists; server prunes hints whose `targetId` disappears from the canvas.
- [Engage seeding produces a generic coach answer] → `prompt` is authored by the HintAgent at generation time with concrete context (target text, source chunk ids), not synthesized at engage time.
- [Cost creep from a third agent] → Per-pass budget ≤ $0.25, effort `low`, heuristic gate skips passes when nothing changed.

## Migration Plan

Additive only: new types, new events, new routes, new component. Existing events/tools/state are untouched, so no rollback complexity — disabling the HintAgent (config flag `hints.enabled`) fully reverts behavior. Old session snapshots without `hints` hydrate with an empty array.

## Open Questions

- Should engaged hints leave the canvas immediately or linger (e.g. faded) until the coach reply completes? Default: remove on engage, since the conversation now carries the topic.
- Should "next-topic" hints ever fire before any canvas content exists (cold start)? Default: no — require at least one synthesis pass first.

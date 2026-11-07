# Improve Agent Responsiveness

## Why

Every LLM call in the app — Synthesizer, Coach, Hints, and the spec pipeline — is serialized through a single FIFO mutex (`runner.ts`). A facilitator question submitted mid-synthesis waits for the entire pass (up to 90s) before its first token, hints silently skip whenever the lock is busy, and the UI shows nothing while work is queued or when a pass fails. For a live-workshop tool, perceived responsiveness of the Coach and visibility into what the agents are doing matter more than raw synthesis throughput.

## What Changes

- Replace the raw FIFO promise-chain lock with a small priority-aware scheduler: coach requests jump ahead of pending synthesizer/hint work; synthesizer and hint passes keep their existing serialization guarantees (no concurrent `query()` calls — SDK constraint stands).
- Bound the Coach's time-to-first-token: emit an immediate "thinking" state to the UI on submit, and cap the coach prompt context (windowed transcript + compact canvas summary) so TTFT stops degrading as the session grows.
- Emit lifecycle status events (`queued` / `running` / `done` / `failed`) for every agent, not just the synthesizer, and surface failures to the client instead of `console.error`-only.
- Coalesce `canvas.updated` broadcasts: one event per batch `update_canvas` tool call instead of one full-canvas broadcast per sticky upsert.
- Hints continue to yield to higher-priority work, but via the scheduler's priority ordering rather than an ad-hoc `queryLockBusy()` check.

## Capabilities

### New Capabilities

- `agent-scheduling`: Priority-aware serialization of agent runs — coach-priority lane, FIFO within a priority class, preserved single-flight `query()` guarantee, and bounded queue-wait behavior for low-priority (hint) work.
- `coach-responsiveness`: Fast perceived response for coach chat — immediate pending/thinking indicator on submit, streamed first token within a target budget, and bounded prompt context so latency stays flat over long sessions.
- `agent-status-visibility`: Client-visible lifecycle status (queued/running/failed) for synthesizer, coach, and hint runs, including error surfacing when a pass times out or aborts.
- `canvas-broadcast-coalescing`: A single `canvas.updated` broadcast per batch canvas mutation instead of one full-canvas event per item.

### Modified Capabilities

_None — `openspec/specs/` is empty; no synced main specs exist yet._

## Impact

- **Server**: `packages/server/src/agents/runner.ts` (lock → scheduler), `SynthesizerAgent.ts`, `HintAgent.ts`, `CoachAgent.ts` (status events, context bounding), `memory/SessionMemory.ts` (broadcast coalescing), `index.ts` (SSE catch-up for new status events).
- **Shared**: `packages/shared/src/events.ts` — new/extended event types (`agent.status`, extended `synth.status` or a generalized replacement).
- **Web**: `packages/web/src/api/useSessionStream.ts`, `CoachChat.tsx`, `SessionControls.tsx` — pending coach bubble, per-agent status chips, error toasts/indicators.
- **No breaking external APIs**; SSE event union grows (existing clients ignore unknown events after a reload).
- **Risk boundary**: the Agent SDK constraint that concurrent `query()` calls interfere is respected — this change reorders and instruments work; it does not parallelize LLM calls.

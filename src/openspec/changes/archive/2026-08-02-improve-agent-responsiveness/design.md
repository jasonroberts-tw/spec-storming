# Design: Improve Agent Responsiveness

## Context

All LLM work funnels through `runAgent` in `packages/server/src/agents/runner.ts`, guarded by a promise-chain FIFO mutex (`queryLock`, runner.ts:19-36). This exists because concurrent Agent SDK `query()` calls interfere (one can return empty) — that constraint is real and must be preserved. Current pain points:

- **Coach starvation**: `CoachAgent.ask()` acquires the same lock with no priority. A question submitted mid-synthesis waits up to 90s (or behind 5+ sequential pipeline calls) before its first token. The pass timeout starts only *after* lock acquisition (runner.ts:78-79), so queue wait is unbounded.
- **Coach TTFT degrades over time**: `sessionContext` (CoachAgent.ts:21-35) inlines the entire transcript plus whole canvas into every prompt.
- **Hints starve by design**: `shouldRun` bails if `queryLockBusy()` (HintAgent.ts:119); during continuous replay the lock is nearly always busy, so hints only fire in lulls.
- **UI blindness**: only `synth.status` exists. No coach pending state (first bubble appears at first `coach.delta`), no hint status, no queued-vs-running distinction, and all failures are `console.error`-only.
- **Broadcast amplification**: each item upsert inside a batch `update_canvas` call emits its own full-canvas `canvas.updated` (SessionMemory.ts:160-170) — N stickies = N full-canvas SSE broadcasts to every client.

Transport is SSE (`index.ts:44-80`) with full catch-up replay on connect; events are defined in `packages/shared/src/events.ts`.

## Goals / Non-Goals

**Goals:**
- Coach first token within a small, session-length-independent budget (target: ≤5s after any in-flight pass completes; never queued behind other *pending* work).
- Every agent run has client-visible lifecycle state, including failure.
- Hints get scheduled fairly (deferred, not silently dropped) without delaying coach or synthesis.
- One `canvas.updated` broadcast per batch mutation.

**Non-Goals:**
- Parallelizing `query()` calls (SDK constraint stands).
- Preempting/aborting an in-flight pass to let the coach cut in — an in-flight synthesis pass runs to completion; priority applies to the queue only.
- Persistent/streaming synthesizer sessions (previously attempted, stalled — see bd memory).
- Live ingestion, pipeline parallelization, model/effort retuning.

## Decisions

### D1: Priority queue scheduler replacing the promise-chain mutex

Replace `queryLock`/`acquireQueryLock` with a small `AgentScheduler` in `runner.ts`:

- `schedule(job, {priority, label})` where priority ∈ `{coach: 0, synthesizer: 1, pipeline: 1, hint: 2}` (lower = sooner). FIFO within a class.
- Single-flight: exactly one job executes at a time; on completion the scheduler dequeues the highest-priority pending job.
- `runAgent` gains an `opts.priority`/`opts.agent` field; all callers pass their identity. `queryLockBusy()` is kept as a shim over `scheduler.busy()` until HintAgent is migrated, then deleted.

*Why not preemption (abort in-flight synthesis when coach arrives)?* A killed synthesis pass wastes its whole cost and loses its `update_canvas` batch; passes already cap at 90s and coalesce via `dirty`. Queue-jump alone cuts worst-case coach wait from "entire queue" to "remainder of current pass".

*Why not a library (p-queue)?* ~40 lines of code, zero-dep hackathon codebase; a bespoke queue also lets us emit `queued`/`running` transitions as scheduler events (D3).

### D2: Hints defer instead of skip

`HintAgent.shouldRun` drops the `queryLockBusy()` check; instead the hint pass is submitted at `hint` priority. The scheduler runs it when nothing more important is pending. Existing gates (60s min interval, ≥4 new chunks, cap 3 active, arm-once 30s timer) stay. Add one new guard: a hint job still pending when a newer hint pass is enqueued is replaced (only ever one queued hint job).

### D3: Generalized `agent.status` event

Add to `packages/shared/src/events.ts`:

```ts
{ type: "agent.status", agent: "synthesizer" | "coach" | "hints" | "pipeline",
  state: "queued" | "running" | "done" | "failed", detail?: string }
```

- Emitted by the scheduler on enqueue/dequeue/settle, so timing is truthful (today `synth.status {running:true}` fires *before* the lock is even acquired).
- `synth.status` remains emitted for back-compat during the change, removed at the end (web client is in-repo; update both sides).
- Failures (timeout, abort, SDK error) emit `state:"failed"` with a short `detail`; server keeps the full error in logs.
- SSE catch-up replay includes the latest status per agent.

### D4: Coach pending state + bounded context

- **Client**: on submit, the reducer immediately appends an empty assistant bubble in `pending` state (spinner/"thinking…"); first `coach.delta` flips it to streaming; `agent.status failed` for coach renders an inline error in the bubble with a retry affordance.
- **Server**: `CoachAgent.sessionContext` becomes bounded: last N transcript chunks (N=30) plus a compact canvas summary (counts + titles per bounded context, full text only for hotspots and unplaced stickies), instead of full transcript + full canvas JSON. Keeps prompt size — and TTFT — flat over session length.

*Why not summarize with an LLM call?* Adds another serialized query; a structural digest is deterministic and free.

### D5: Coalesced canvas broadcasts

`SessionMemory` gets a batch write API (`applyCanvasBatch(items)`) that performs all upserts, bumps `rev` once, and emits a single `canvas.updated` at the end. The `update_canvas` MCP tool (canvasTools.ts) calls it instead of per-item upserts. Per-item emit path stays for any single-item callers. Incremental fill-in during a pass is lost (canvas now updates once per tool call, which is already once per pass) — acceptable: the batch applies in one tick, so users saw a burst, not a progression.

## Risks / Trade-offs

- [Coach still waits behind an in-flight 90s synthesis pass] → Acceptable worst case; `agent.status` makes the wait visible ("waiting for synthesizer…"). If it proves painful, preemption can be layered onto the scheduler later without API change.
- [Starvation inversion: constant coach traffic could starve synthesis] → Coach calls are human-paced (one facilitator); synthesizer coalescing (`dirty`) means it needs only one slot to catch up. No mitigation needed now.
- [Bounded coach context omits something the facilitator asks about] → Window of 30 chunks ≈ 90s+ of replay plus full canvas structure; the coach can say what it doesn't know. Tunable constant.
- [Scheduler rewrite regresses the empty-result serialization fix] → Single-flight invariant is the one hard rule; cover with a unit test that enqueues overlapping jobs and asserts no interleaving.
- [Removing `synth.status` breaks the UI chip mid-change] → Migrate emit + consume in the same task; keep dual-emit until the web reducer reads `agent.status`.

## Open Questions

- None blocking. Priority of `pipeline` vs `synthesizer` (both 1) can be revisited if the pipeline's 5+ sequential calls ever run during live synthesis; today the pipeline runs at session finish.

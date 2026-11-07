# Tasks: Improve Agent Responsiveness

## 1. Scheduler core (agent-scheduling)

- [x] 1.1 Implement `AgentScheduler` in `packages/server/src/agents/runner.ts`: priority queue (coach=0, synthesizer/pipeline=1, hint=2), FIFO within class, single-flight execution, emits lifecycle callbacks on enqueue/start/settle
- [x] 1.2 Add unit test asserting no interleaving: enqueue overlapping jobs across priorities, verify one-at-a-time execution and priority/FIFO dequeue order
- [x] 1.3 Route `runAgent` through the scheduler with a required `agent`/priority option; update all callers (SynthesizerAgent, CoachAgent, HintAgent, pipeline orchestrator) to pass identity
- [x] 1.4 Start the pass timeout at execution start (not submission) and keep `queryLockBusy()` as a temporary shim over `scheduler.busy()`

## 2. Hint deferral (agent-scheduling)

- [x] 2.1 Remove the `queryLockBusy()` skip from `HintAgent.shouldRun`; submit hint passes at hint priority instead
- [x] 2.2 Implement replace-pending-hint semantics (at most one queued hint job); delete the `queryLockBusy` shim once no callers remain

## 3. Status events (agent-status-visibility)

- [x] 3.1 Add `agent.status` event type (`agent`, `state: queued|running|done|failed`, `detail?`) to `packages/shared/src/events.ts`
- [x] 3.2 Emit `agent.status` from scheduler lifecycle callbacks for all four agents; include short detail on failure (timeout/abort/error) instead of console-only logging
- [x] 3.3 Include latest per-agent status in the SSE catch-up replay in `index.ts`
- [x] 3.4 Update web reducer (`useSessionStream.ts`) to track per-agent status; drive the synthesizing/building chips in `SessionControls.tsx` from `agent.status`, with queued-vs-running distinction and a failure indicator; then remove the legacy `synth.status` emit and handler

## 4. Coach responsiveness (coach-responsiveness)

- [x] 4.1 Client: append a pending assistant bubble immediately on submit in `CoachChat.tsx`/reducer; transition to streaming on first `coach.delta`; show inline error state on coach `agent.status failed`
- [x] 4.2 Server: replace `CoachAgent.sessionContext` full transcript+canvas dump with bounded context — last 30 transcript chunks plus compact canvas summary (per-BC counts/titles, full text only for hotspots and unplaced stickies)
- [x] 4.3 Verify TTFT stays flat: exercise coach on a long replayed session and confirm prompt size and first-token latency are independent of transcript length

## 5. Canvas broadcast coalescing (canvas-broadcast-coalescing)

- [x] 5.1 Add `applyCanvasBatch(items)` to `SessionMemory`: apply all upserts, bump `rev` once, emit one `canvas.updated` with final state (preserve per-item emit for single-item callers)
- [x] 5.2 Switch the `update_canvas` MCP tool (`canvasTools.ts`) to `applyCanvasBatch`; verify N-item batch produces exactly one SSE broadcast

## 6. Verification & close-out

- [x] 6.1 Run a full transcript replay end-to-end: confirm coach question mid-synthesis gets pending bubble immediately and first token right after current pass; hints fire during continuous replay (no lull required); no interleaved/empty query results
- [x] 6.2 Run build/typecheck (`tsc --noEmit` across packages) and existing tests; fix all errors
- [x] 6.3 Commit, update beads issues, and push

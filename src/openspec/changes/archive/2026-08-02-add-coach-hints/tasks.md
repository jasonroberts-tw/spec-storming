# Tasks: Add Coach Hints

## 1. Shared types and events

- [x] 1.1 Add `Hint`, `HintKind`, `HintStatus` types to `packages/shared/src` (new `hints.ts` or alongside canvas types) and export from the package index
- [x] 1.2 Add `hints.updated` variant (full active-hints list) to the `ServerEvent` union in `packages/shared/src/events.ts`
- [x] 1.3 Add `hints: Hint[]` to `SessionState` in `packages/shared/src/session.ts`, defaulting to an empty array for old snapshots on hydrate

## 2. Session memory and hint store

- [x] 2.1 Add `upsertHint()`, `setHintStatus(id, status)`, and `activeHints()` to `packages/server/src/memory/SessionMemory.ts`, each emitting `hints.updated` with the current active list
- [x] 2.2 Track dismissed hint ids/topics for the session so generation can exclude them
- [x] 2.3 Prune active hints whose `targetId` no longer exists in the canvas (hook into canvas commit) and emit `hints.updated` when pruning occurs
- [x] 2.4 Include hints in the debounced session snapshot and restore them on hydrate

## 3. HintAgent (generation)

- [x] 3.1 Create `packages/server/src/agents/tools/hintTools.ts` with a batch `suggest_hints` MCP tool that upserts an array of hints (id, kind, text, prompt, targetId?, sourceChunkIds?) capped at the active-hint limit
- [x] 3.2 Create `packages/server/src/agents/HintAgent.ts` modeled on `SynthesizerAgent`: debounced on transcript/canvas activity, minimum interval between passes, heuristic gate (skip when no undiscussed hotspot / thin BC / new chunks), skip when the global query lock is busy
- [x] 3.3 Write the hint system prompt: coach persona, the five hint kinds, "return zero hints by default", include current active + dismissed hints and canvas summary in the pass input, require pre-authored `prompt` per hint with concrete target context
- [x] 3.4 Configure the pass: `effort: 'low'`, fresh MCP server per pass, ~60s timeout, per-pass budget ≤ $0.25, and a `hints.enabled` config flag; wire the agent into server startup in `packages/server/src/index.ts`
- [x] 3.5 Add Langfuse tracing for hint passes consistent with the other agents

## 4. Engage and dismiss API

- [x] 4.1 Add `POST /api/hint/:id/dismiss`: validate hint exists and is `active` (else 4xx), set status `dismissed`, record the dismissed topic
- [x] 4.2 Add `POST /api/hint/:id/engage`: validate hint is `active` (else 4xx), set status `engaged`, append a hint-derived user-role message to coach chat, then invoke `coach.ask()` with the hint's `prompt` plus target-element context; response streams via existing `coach.delta`/`coach.done`
- [x] 4.3 Ensure engaged-hint exchanges appear in the chat history passed to subsequent coach calls (follow-up questions get the context)

## 5. Web UI

- [x] 5.1 Handle `hints.updated` in `packages/web/src/api/useSessionStream.ts` (replace hints array; include hints in SSE catch-up handling)
- [x] 5.2 Create `HintChip` component: distinct lightweight styling per kind, freshness animation on first display, engage and dismiss buttons
- [x] 5.3 Render the hints area in `packages/web/src/components/Canvas.tsx`; hovering/focusing a hint with a `targetId` highlights the matching sticky/hotspot/BC
- [x] 5.4 Wire engage: call the engage route and move focus to the coach chat panel; wire dismiss to the dismiss route
- [x] 5.5 Show the hint-derived seed message in `CoachChat.tsx` chat history like a normal user message

## 6. Server catch-up and verification

- [x] 6.1 Replay current active hints in the SSE catch-up sequence on client connect in `packages/server/src/index.ts`
- [x] 6.2 Run `tsc --noEmit` / package builds across shared, server, and web; fix all errors
- [x] 6.3 Manual verification with a replayed session: hints appear occasionally (respecting cap and interval), engage seeds a coach reply, dismiss removes across two connected clients, dismissed topics are not re-suggested, late-joining client sees active hints

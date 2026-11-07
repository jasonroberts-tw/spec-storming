# Design: add-mural-projection

## Context

The canvas is a semantic model with **zero geometry**: `Sticky` is `{id, kind, text, confidence, sourceChunkIds, order?, boundedContextId?}` (`packages/shared/src/canvas.ts:37`) and layout is derived at render time by sorting kinds into flex-wrapped columns (`packages/web/src/components/Canvas.tsx`). The write path is a single choke point — the SynthesizerAgent is the sole canvas writer via one batch `update_canvas` MCP tool (`packages/server/src/agents/tools/canvasTools.ts`) funneling into `SessionMemory.applyCanvasBatch`, which commits one revision bump and one `canvas.updated` broadcast on the EventBus. Multiple readers (HintAgent, CoachAgent, pipeline, SSE) consume canvas state; none write it. Session state persists as a debounced whole-state JSON snapshot (`data/sessions/<id>/session.json`).

Mural API facts (verified 2026-08 at developers.mural.co):

- Widget CRUD at `app.mural.co/api/public/v1/murals/{muralId}/widgets/...`; sticky-note/shape/text create accept **arrays up to 1000/call**; arrows and areas are single-create; `PATCH .../widgets/{type}/{id}` updates any field including `x`/`y`; `DELETE` by id.
- Auth is **OAuth 2.0 Authorization Code + PKCE only** — no API keys or personal tokens. Access tokens expire in 15 minutes; refresh tokens are reusable. Scopes: `murals:read`, `murals:write`.
- Rate limits: 25 req/s per user, 10k/60s per app — a batched array counts as one request; not a constraint at session scale.
- **No webhooks** — human edits are observable only by polling `GET .../widgets`.
- Embeds (`app.mural.co/embed/{id}`) are **view-only** and work without viewer login; must be enabled per-mural.
- Known quirk (community-reported): `backgroundColor` may not apply on sticky create and may need a follow-up PATCH.

Data-signal reliability (drives layout decisions): `kind` always present; `boundedContextId` commonly assigned by the synthesizer; `order` is in the tool schema but **the synthesizer prompt never mentions it** — treat as sparse; `links`/`StickyLink` types exist but are never populated (the tool schema omits them); `createdAtRev` is a reliable monotonic arrival order. `SessionMemory` never deletes stickies (upsert-only), so the projector needs no sticky-delete path.

## Goals / Non-Goals

**Goals:**

- Project canvas state (stickies, bounded contexts, hotspots) one-way onto a real Mural board, live during a session, without touching the synthesizer or any existing reader.
- Board stays visually stable across synthesis passes: items don't teleport; existing human arrangements of *agent-created* widgets are not clobbered by cosmetic updates.
- Survive server restarts and session re-hydration without duplicating widgets.
- Degrade gracefully: Mural down / not connected → app works exactly as today.

**Non-Goals:**

- Reading human board edits back into `SessionMemory` (no webhooks; poll-based read-back is a future change).
- Projecting arrows/`links` (the data is never populated today) or full BCC detail (purpose, ubiquitous language, open questions stay in the web UI's BCC cards).
- Multi-session/multi-board management, Mural workspace administration, or write access from the embedded iframe (Mural embeds are read-only).

## Decisions

### D1: Projection, not replacement — SessionMemory stays the source of truth

The MuralProjector is a new EventBus subscriber to `canvas.updated`, exactly like the SSE fan-out and `pruneStaleHints`. The synthesizer, `update_canvas`, and all agent read paths are untouched. *Alternative rejected:* making Mural the canonical store would force HintAgent/CoachAgent/pipeline to read via Mural's API (poll-only, rate-limited, lossy vs. the rich BCC model).

### D2: Layout = bounded-context neighborhoods, not timeline or swimlanes

One Mural **area** per bounded context (title = BC name; border color by `core`/`supporting`/`generic`), member stickies inside arranged in kind-rows (EventStorming reading order: events row, commands row, then actors/policies/read-models/etc.). An "Unplaced" parking-lot area for stickies with no `boundedContextId`; a hotspot strip along the bottom rendering both top-level `canvas.hotspots` and `kind:"hotspot"` stickies as pink stickies rotated 45° (Mural supports `rotation`), unified by id. Within a row, sort by `order ?? createdAtRev`. *Alternatives rejected:* pure kind-swimlanes (stable but reads as an inventory, not a model); timeline-spine layout (authentic Big Picture EventStorming, but depends on `order` — which the prompt never requests — and on command→event links, which don't exist; inherently unstable to mid-timeline insertion).

### D3: Stability contract — write-once slot allocation, not pure-function layout

A layout that is a pure function of the whole canvas reshuffles the board every pass. Instead the layout engine is an **incremental allocator with memory**:

- A sticky gets coordinates once, at creation, from its container's next free slot on a fixed grid (138px Mural sticky default, ~168px pitch). Text/style updates never touch `x`/`y`.
- The **only** semantic move: `boundedContextId` changed → PATCH the sticky into its new area's next slot.
- Areas grow (PATCH height) when a row wraps; contents never reflow. Pre-allocate generous area width (~6 sticky columns).
- Deletions would leave gaps rather than compact (moot today: stickies are never deleted).
- **Explicit "tidy board" action** (button in web UI → server endpoint) performs a full recompute: re-sort rows by `order`, compact gaps, resize/repack areas. Reflow is deliberate, never continuous.

### D4: Projector state lives in the session snapshot

`stickyId → {widgetId, container, slot}` maps (and the same for areas/hotspots), per-container slot cursors, the bound `muralId`, and `lastProjectedRev` are added to `SessionState` and ride the existing debounced snapshot. On hydrate, the projector resumes diffing from `lastProjectedRev` — no duplicate widgets after restart. *Alternative rejected:* reconstructing the map by GETting widgets from Mural on boot (extra failure mode, and widget titles/text are not reliable reverse keys).

### D5: Diff by revision markers, apply as batches

On `canvas.updated`, diff `createdAtRev`/`updatedAtRev` against `lastProjectedRev` to classify created vs. updated items. Apply per pass: one batched sticky-note POST for all new stickies, individual area POSTs (unbatched in the API) for new BCs, PATCHes for text/style changes and BC re-assignment. Passes are serialized (single in-flight projection; coalesce if a new revision lands mid-flight — mirrors the synthesizer's own dirty/running coalescing pattern). If the color-on-create quirk is confirmed, fold the follow-up color PATCHes into the same pass.

### D6: OAuth handled server-side; tokens on disk; fail-soft

Standard Authorization Code + PKCE flow: server exposes `/api/mural/connect` (redirect to Mural authorize) and `/api/mural/callback`; tokens stored server-side (JSON file under `data/`, fine for hackathon scope) with proactive refresh (~2 min before the 15-min expiry) and reactive refresh on 401. Client id/secret via env vars. Any Mural API failure logs and marks the projector degraded — it never blocks or breaks the session; canvas/SSE flow is unaffected, and the projector re-syncs the missed range on the next pass (diff-from-`lastProjectedRev` makes retries idempotent).

### D7: Embed in the web UI; React canvas becomes fallback

When a session is bound to a mural, the web UI shows the view-only embed iframe (`app.mural.co/embed/{id}`) in place of the React canvas; hints, coach, transcript, and status panels are unchanged (hint hover-highlighting into the board is lost inside the iframe — accepted; BCC cards remain rendered by the web UI beneath/alongside). No Mural connection → today's UI exactly.

### D8: Nudge the synthesizer prompt for `order` (one line, optional)

Add one sentence to the synthesizer steering: set `order` reflecting business-process sequence, spaced by 10. Cheap, materially improves within-row ordering and the "tidy" recompute. Kept as a separate task so it can be dropped if it disturbs the latency-tuned prompt.

## Amendments (reconciliation with the parallel mcp-mural work)

Three decisions above were superseded once a second, independent Mural integration landed and the two were reconciled (tasks §9):

- **D5 amended — transport is MCP, not direct REST.** Board writes go through the vendored `mcp-mural` MCP server (`uv run mural-mcp`) rather than `fetch`. The batching, diffing, and coalescing described in D5 are unchanged; only the call mechanism moved. `mcp-mural`'s own `tool_apply_diagram` is deliberately **not** used — it is a competing brain (its own layout engine, its own idempotency store, and a renderer that re-creates every connector on every call), and adopting it would mean deleting the layout engine, projection state, and tidy. The subprocess is spawned lazily so a missing `uv` degrades rather than blocks.
- **D3 amended — areas are real containers.** Stickies are now nested via `parentId`; see the resolved risk below. The write-once stability contract is untouched.
- **Non-goal reversed — arrows are projected.** `links` are now populated (a one-line synthesizer nudge plus a `update_canvas` schema field), so the "the data is never populated today" rationale no longer holds. Connectors are keyed `link:<from>-<relation>-><to>` in the projection state, which is what keeps them from multiplying across passes.

## Risks / Trade-offs

- [`parentId` coordinate space unknown — relative vs. absolute changes all placement math] → **Answered, and `parentId` is now used.** Mural's docs state a child's x/y is "the distance from the left of the parent widget, such as an area" ([Get widgets for a mural](https://developers.mural.co/public/reference/getmuralwidgets)). The layout engine still computes board-absolute coordinates — one coordinate system for slots, area rects, and connector geometry — and `toParentCoords` rebases only at the API boundary. Bounded contexts therefore drag their stickies with them, and `layout.test.ts` needed no changes.
- [`backgroundColor` may not apply on batch create] → Spike S2; if confirmed, batch-create then batch-PATCH colors in the same pass (still ~2 requests).
- [OAuth flow is the schedule risk — app registration, redirect URLs, token refresh] → Spike S1 doubles as the end-to-end OAuth proof; do it first; Postman-token workaround acceptable for local dev.
- [Human moves an agent widget, then the agent updates that sticky's text] → Write-once placement means the PATCH carries no `x`/`y`, so human positioning survives text updates. But a BC re-assignment *will* move a human-positioned sticky — accepted as semantically correct.
- ["Tidy" clobbers all human arrangement] → It's explicit and user-triggered; acceptable by construction.
- [Token/secret handling] → Tokens and client secret never reach the browser; server-side only. `data/` is git-ignored (verify).
- [Free-tier limits: 5 murals, 3 editable] → Bind sessions to one designated demo mural; document in runbook.
- [Embed disabled by workspace admin] → Check per-mural embed toggle during binding; surface a clear error in the connect flow.

## Migration Plan

Additive feature behind a "Mural connected" state; no data migration. `SessionState` gains optional `mural` fields — old snapshots hydrate fine (field absent → projector idle). Rollback = disconnect Mural (or unset env vars); the React canvas fallback is the pre-change UI.

## Open Questions

- ~~Does an area PATCH (move/resize) drag nested children with it?~~ Moot: `parentId` is not used (see Risks).
- ~~Backfill on bind or deltas only?~~ Decided: bind resets projection state to `lastProjectedRev: 0`, so the first pass projects the entire current canvas as one batched pass, then deltas.
- Mural sticky text limits (length/markdown?) for long sticky labels — verify during S2 and truncate defensively.

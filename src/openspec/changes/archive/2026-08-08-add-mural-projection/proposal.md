# Proposal: add-mural-projection

## Why

SpecStorming's canvas is a read-only React panel — a flex-wrapped list with no spatial layout, no zoom, and no workshop feel. Projecting the canvas onto a real Mural board gives the synthesizer a professional, familiar whiteboard to "draw" on live during a session (stickies, bounded-context areas, EventStorming colors), which is both a far stronger demo and a path toward workshops where participants already live in Mural.

## What Changes

- Add a **Mural connection** flow: OAuth 2.0 (PKCE) app authorization, token storage with 15-minute access-token refresh, and selection/creation of a target mural for the session. Mural offers no API keys — OAuth is mandatory.
- Add a **layout engine** that invents board geometry for canvas items (the canvas data model has no x/y): bounded contexts become Mural areas with member stickies arranged in kind-rows inside; unplaced stickies go to a parking-lot area; hotspots render as rotated pink stickies in a hotspot strip. Placement is slot-based and write-once for stability; stickies re-place only when their bounded-context assignment changes.
- Add a **MuralProjector** that subscribes to `canvas.updated` on the EventBus (a new reader — the synthesizer, `update_canvas` tool, and SessionMemory are untouched), diffs canvas revisions, and applies changes via Mural's REST API using batch widget creation (up to 1000 stickies/call, well inside the 25 req/s rate limit). Projector state (stickyId → Mural widget id, slot allocations) persists in the existing session snapshot.
- Embed the mural **view-only** in the web UI next to the existing transcript/hints/coach panels (Mural embeds are iframe, read-only, no viewer login required). The existing React canvas remains as fallback when no Mural is connected.
- Out of scope (future change): reading human edits back from the board (Mural has no webhooks; poll-only), arrows/links between stickies, projecting full bounded-context-canvas detail (only area name + classification project; rich BCC cards stay in the web UI).

## Capabilities

### New Capabilities

- `mural-connection`: OAuth 2.0 PKCE authorization against Mural, token persistence and refresh, and binding a session to a target mural board.
- `mural-layout`: deterministic, incrementally stable placement of canvas items on a coordinate board — slot allocation, write-once placement, bounded-context areas, re-placement rules, and explicit full "tidy" reflow.
- `mural-projection`: one-way sync of canvas state to the bound mural — revision diffing, batched widget create/update, id mapping, snapshot persistence, failure tolerance, and view-only embed in the web UI.

### Modified Capabilities

<!-- none — the synthesizer, canvas data model, and existing agent read paths are unchanged -->

## Impact

- **Server**: new `packages/server/src/mural/` module (OAuth client, projector, layout engine); new EventBus subscriber; new HTTP routes for the OAuth redirect flow and mural binding; projector state added to the session snapshot shape.
- **Web**: session view gains an embedded mural iframe + "Connect Mural" affordance; existing Canvas component becomes the no-Mural fallback.
- **Dependencies**: Mural public REST API (`app.mural.co/api/public/v1`); a registered Mural OAuth app (client id/secret via env vars); no new npm dependencies expected beyond what's installed.
- **Unchanged**: `update_canvas` MCP tool, SynthesizerAgent, HintAgent, CoachAgent, pipeline serialization, SSE canvas broadcast.
- **Risks spiked first**: coordinate space of widgets nested in areas (`parentId`), whether `backgroundColor` applies on batch sticky create, and the end-to-end OAuth registration flow.

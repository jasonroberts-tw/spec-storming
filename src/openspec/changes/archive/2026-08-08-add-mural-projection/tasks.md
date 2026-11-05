# Tasks: add-mural-projection

## 1. Spikes (de-risk before building)

- [x] 1.1 Register a Mural OAuth app; prove the Authorization Code + PKCE flow end-to-end with curl/scratch script (authorize → code → token → refresh); record client id/secret env var names in the runbook
- [x] 1.2 Spike S1: create an area + a sticky with `parentId` via the API, GET both back; determine whether child coordinates are area-relative or board-absolute, and whether moving the area moves children — decide `parentId` vs. background-rectangle areas and record the decision in design.md
- [x] 1.3 Spike S2: batch-create ~30 stickies with `backgroundColor`, `rotation`, and long text in one call; verify colors/rotation/positions land as specified, confirm or refute the color-on-create quirk, and note any text-length limits

## 2. Mural connection (auth + binding)

- [x] 2.1 Implement `packages/server/src/mural/auth.ts`: PKCE helper, token store (JSON under `data/`, git-ignored — verify), proactive refresh ~2 min before expiry, reactive refresh-and-retry-once on 401
- [x] 2.2 Add routes: `GET /api/mural/connect` (redirect with PKCE challenge), `GET /api/mural/callback` (code exchange), `GET /api/mural/status` (connected/degraded/idle for the UI)
- [x] 2.3 Implement session-to-mural binding: `POST /api/mural/bind` verifying the mural is reachable, persisting `muralId` into session state, and triggering full-canvas backfill projection

## 3. Layout engine

- [x] 3.1 Implement `packages/server/src/mural/layout.ts`: grid constants (138px sticky, ~168px pitch), container model (BC areas, Unplaced area, hotspot strip), kind-row assignment in EventStorming reading order, within-row sort by `order ?? createdAtRev`
- [x] 3.2 Implement the slot allocator: per-container next-free-slot cursors, write-once placement, row wrap with area growth (no reflow of existing items), relocation only on `boundedContextId` change
- [x] 3.3 Map styles: kind → EventStorming `backgroundColor`, low-confidence visual encoding, hotspot 45° rotation, area border by strategic classification; unify top-level hotspots and `kind:"hotspot"` stickies by id
- [x] 3.4 Unit-test the allocator: write-once stability across passes, BC reassignment, row wrap, hotspot dedup, deterministic output for identical input

## 4. Projector

- [x] 4.1 Implement `packages/server/src/mural/MuralProjector.ts`: subscribe to `canvas.updated`, diff via `createdAtRev`/`updatedAtRev` vs. `lastProjectedRev`, serialize passes with dirty/running coalescing (mirror SynthesizerAgent's pattern)
- [x] 4.2 Implement the Mural API client: batched sticky create, individual area create, PATCH text/style/position, rate-limit-aware error handling; fold color-fix PATCH into the pass if S2 confirmed the quirk
- [x] 4.3 Extend `SessionState`/snapshot with projector state (id map, slot cursors, `muralId`, `lastProjectedRev`); hydrate resumes without duplicating widgets; old snapshots hydrate with projector idle
- [x] 4.4 Failure tolerance: any Mural failure logs + marks degraded, never advances `lastProjectedRev` past unapplied changes, never blocks session processing; catch-up on next pass
- [x] 4.5 Implement backfill projection (used by bind): project the entire current canvas as one batched pass

## 5. Tidy reflow

- [x] 5.1 Add `POST /api/mural/tidy`: full layout recompute (re-sort by `order`, compact gaps, repack/resize areas), batch-PATCH all positions, rebuild allocator state
- [x] 5.2 Add a "Tidy board" button to the web UI, visible only when a mural is bound

## 6. Web UI

- [x] 6.1 Add "Connect Mural" affordance + connection status chip driven by `/api/mural/status`
- [x] 6.2 Render the view-only embed iframe (`app.mural.co/embed/{id}`) in place of the React canvas when bound; keep hints, coach, transcript, agent status, and BCC detail cards; unbound sessions render today's canvas unchanged

## 7. Synthesizer nudge (optional, isolated)

- [x] 7.1 Add one steering sentence asking the synthesizer to set `order` by business-process sequence, spaced by 10; verify pass latency and canvas quality are unaffected (drop if not)

## 8. Verification & wrap-up

- [x] 8.1 Run `tsc --noEmit` / project build across packages; fix all errors
- [x] 8.2 End-to-end demo run: replay transcript with a bound mural — verify live sticky/area creation, stability across passes, restart-without-duplication, Mural-down degradation, and tidy; update the demo runbook with Mural app setup

## 9. Reconciliation with the parallel mcp-mural work

A second Mural integration (`MuralSyncService` → Python `mcp-mural` via `tool_apply_diagram`) landed
independently. Both wrote to Mural. Resolution: keep this projector's brain (write-once placement,
revision diffing, projection state, tidy) and move its *transport* onto `mcp-mural`'s primitive tools.

- [x] 9.1 Vendor `mcp-mural` as real files (was a gitlink with no `.gitmodules`, so clones got an empty
      dir); ignore Python build artifacts; delete `MuralSyncService`, `canvasToMetamodelJson`,
      `Sticky.position`/`muralWidgetId`, and `SessionMemory.setMuralWidgetIds`
- [x] 9.2 Extend `mcp-mural`: `tool_set_target` (per-session board — it previously wrote to one fixed
      `MURAL_ID`), `tool_set_auth` (host-owned OAuth), `tool_get_mural`, `tool_update_frame`,
      `tool_delete_widget`, `frame_id`/`rotation`/`italic` on cards, hex passthrough in `resolve_color`,
      429 wait-and-retry in `client._send`; 16 pytest cases
- [x] 9.3 Replace `MuralClient` with `MuralMcp` (stdio, lazy fail-soft spawn, FastMCP text-error →
      `MuralApiError`, per-pass target/token push); add a trailing debounce to `requestPass`
- [x] 9.4 Fix: a widget deleted on the board wedged projection permanently (404 → degraded → watermark
      never advanced → same dead id retried forever). `patchOrForget` drops the entry and holds the
      watermark so the next pass recreates it
- [x] 9.5 Nest stickies under their bounded-context area via `parentId` (resolves S1 — the docs confirm
      child coordinates are parent-relative). `toParentCoords` converts at the API boundary so the
      allocator stays board-absolute and `layout.test.ts` is unchanged
- [x] 9.6 Populate `links`: add to the `update_canvas` schema and `upsertSticky`, one steering line in the
      synthesizer prompt, links shown in the canvas summary
- [x] 9.7 Project links as connectors, keyed `link:<from>-<relation>-><to>` so they survive restarts and
      never duplicate; delete on link removal; cap creates per pass
- [ ] 9.8 Live verification with real credentials — see "Live end-to-end" in the plan: binding a second
      board, containment drag, no-duplicate-arrows over 5+ passes, deleted-widget self-heal, token
      expiry past 15 min, MCP subprocess kill/recover, tidy

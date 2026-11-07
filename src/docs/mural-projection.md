# Mural Projection — Setup & Demo Runbook

The MuralProjector mirrors the SpecStorming canvas one-way onto a real Mural board:
bounded contexts become areas, stickies land in kind-lanes *inside* them (as real
children — dragging an area moves its stickies), sticky links become arrows, and
hotspots go to a rotated pink strip. The web UI embeds the board view-only; humans who
want to move things use the Mural app itself (placement survives agent text updates by
design).

Board writes go through the vendored **`mcp-mural`** MCP server, spawned on demand as
`uv run mural-mcp`. The projector owns all the logic — diffing, layout, widget-id
bookkeeping, tidy — and uses `mcp-mural` only for the board primitives.

## One-time setup

0. **Install `uv` and Python ≥3.11**, then `cd mcp-mural && uv sync`. Without this the
   app runs fine but every projection pass reports **mural degraded** — the subprocess
   is spawned lazily, so a missing `uv` never blocks startup or a session.
1. **Create a Mural account/workspace** (free tier is fine: 5 murals, 3 editable).
2. **Register an OAuth app**: in Mural, account avatar → *Create and manage apps* →
   new app. Mural has **no API keys** — OAuth 2.0 + PKCE is the only way in.
   - Redirect URL: `http://127.0.0.1:8787/api/mural/callback` (must match exactly —
     including `localhost` vs `127.0.0.1`; set `MURAL_REDIRECT_URI` to whatever you
     registered if it differs, and restart the server after editing `.env`).
   - Scopes used: `murals:read murals:write`.
   - **Enable the app for the company** (deny-by-default): authorization fails with
     "<app> isn't enabled for your company" until a Mural company admin enables it —
     Company dashboard → *Integrations* → enable the app. On a free workspace you
     created, that admin is you.
3. **Set env vars** for the server:

   ```sh
   MURAL_CLIENT_ID=...       # from the registered app
   MURAL_CLIENT_SECRET=...   # from the registered app
   # MURAL_REDIRECT_URI=...  # only if not the default above
   ```

   Tokens are stored server-side in `data/mural/tokens.json` (git-ignored). Access
   tokens live 15 minutes; the server refreshes proactively and on 401.

## Connecting and binding

1. Start the server + web app, open the UI.
2. Click **🔗 Connect Mural** (appears once the app is configured) — approve in the
   opened Mural tab.
3. Create/open a mural in Mural, copy its id from the URL, click **🖼 Bind Mural…**
   and paste it. Binding verifies reachability and backfills the whole current
   canvas in one batched pass; from then on every synthesis pass projects deltas.
4. For the embed to render, enable *Share → Embed* on that mural (embeds are
   view-only and need no viewer login; a company admin can disable embedding
   globally — check this before a demo).

## Demo notes

- **🧹 Tidy board** (top of the embed) is the only thing that reflows the whole
  layout; normal passes never move placed widgets except on bounded-context
  reassignment.
- If Mural is down or tokens expire beyond refresh, the status chip shows
  **mural degraded**; the session keeps working and the projector catches up on the
  next pass after recovery.
- Restarting the server is safe: projection state rides the session snapshot, so
  nothing is duplicated on the board.

## How the pieces fit

- `MuralAuth` (`packages/server/src/mural/auth.ts`) is the **only** OAuth owner. It
  pushes a fresh access token into `mcp-mural` via `tool_set_auth` on each pass, and the
  bound board via `tool_set_target` — so `mcp-mural/mural_mcp/.env` needs no
  `MURAL_ID` or `refresh_token` when running under the server. Those are only for
  driving `mcp-mural` standalone from Cursor.
- `layout.ts` computes everything in **board-absolute** coordinates. Mural measures a
  child widget from its parent area's top-left, so `toParentCoords` rebases at the API
  boundary only — the allocator and its tests never deal in relative space.
- Connectors are keyed `link:<from>-<relation>-><to>` in the projection state, so an
  unchanged link is never redrawn. (Sending links straight through `mcp-mural`'s own
  `tool_apply_diagram` would multiply arrows on every pass — its renderer re-issues
  every connector unconditionally. We don't use that tool.)

## Known gaps

- **Connector endpoint is unverified.** `mcp-mural/mural_mcp/tools/connectors.py` posts
  `/widgets/connector` with `startWidget`/`endWidget`, but the published schema is
  `/widgets/arrow` with `startRefId`/`endRefId` and a `points` array. Confirm against a
  live board before relying on arrows (bd issue `ai-hackathon-2026-89k`).
- **Detaching a sticky from an area** (kind changed to `hotspot` after placement) sends
  `parentId: null`; unverified against the live API.
- If `backgroundColor` is ever dropped on batch create (a community-reported quirk),
  flip `COLOR_FIX_PATCH` to `true` in `packages/server/src/mural/MuralProjector.ts`.

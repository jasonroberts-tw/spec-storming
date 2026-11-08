# SpecStorming (`src/`)

**Written:** 2026-11-05, from the code at commit `aeb9af2` and the `src/openspec/` change archive.
**Status:** amended 2026-11-07 by the change that isolates the agents (no filesystem settings, no
built-in tools, skills moved into `steering/`), adds `src/.gitignore` and links `docs/ARCHITECTURE.md`.
Amended 2026-11-07 by ss-ape, which quotes the server's test glob so that the test script runs every
test file, including those directly under `src/` and in `src/ingest/zoom/`, and drops the gotcha
that said it skipped them.

SpecStorming turns a live EventStorming conversation into a System Specification. The web UI
calls the product "Concept-to-Spec" (`packages/web/src/brand.ts`), and both names mean the same
product.

`docs/ARCHITECTURE.md` at the repository root draws the components and flows as diagrams.

The code wins where this file and the code disagree. The root `AGENTS.md` wins on process: the
delivery tracks, gates, branches and protected tests.

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Types that the server and the web app share. `events.ts` holds the `ServerEvent` union. Consumers import the `.ts` source directly, so the package has no build step. |
| `packages/server` | Fastify 5 server on `127.0.0.1:8787`. It owns the one `SessionMemory`, runs the agents through the Claude Agent SDK, and serves Server-Sent Events (SSE). Every route is in `src/index.ts`. |
| `packages/web` | Vite and React 19 UI on port 5173. Vite proxies `/api` to the server. |
| `steering/` | Domain knowledge and techniques that `loadSteering()` concatenates into agent system prompts. `config.ts` chooses the documents for each agent. |
| `mcp-mural/` | Python Model Context Protocol (MCP) server for Mural board operations. The server spawns it on first use as `uv run mural-mcp`. |
| `docs/` | Setup runbooks for Zoom and Mural. |
| `SpecStorming.docx` | The original concept. It lists each agent's steering and skills, and the 12 sections of the System Specification. |

## How data flows

1. A producer calls `SessionMemory.appendChunk()`. The producers are `TranscriptReplayer` (files in `ingest/transcripts/`), `ZoomRtmsClient`, and `POST /api/ingest/chunk`.
2. `appendChunk` emits `transcript.chunk` on the `EventBus`.
3. The Synthesizer, the HintAgent and the Coach's assessment timer react to bus events.
4. The Synthesizer writes the canvas through the `update_canvas` tool, which calls `SessionMemory.applyCanvasBatch()`.
5. `applyCanvasBatch` bumps the revision once and emits one `canvas.updated`.
6. `GET /api/stream` forwards every bus event to browsers. The `MuralProjector` subscribes to the same bus and mirrors the canvas onto a Mural board.
7. A debounced snapshot writes the session to `data/sessions/demo/session.json`.

The spec pipeline in `pipeline/` runs only when someone calls `POST /api/pipeline/run`. It runs
the Boundary Analyzer, then the Solution Architect, and then a negotiation between a System
Architect agent and a Business/Product agent. An SDD (spec-driven development) fitness evaluator
scores the first two outputs.

## Agents

| Agent | Writes | Runs when | Scheduling |
|---|---|---|---|
| Synthesizer | Canvas: stickies, hotspots, bounded contexts | 3 new chunks arrive, or 5 s pass after one | Bypasses the scheduler through `runAgentDirect`, with up to 3 windows in parallel |
| Coach chat | `coachChat` | The facilitator sends a message or engages a hint | Scheduler, priority 1 |
| Coach assessment | `coachChat` entries of kind `assessment` | New evidence arrives, at most once a minute | Scheduler, priority 3 |
| HintAgent | `hints` | 30 s of quiet, 60 s since the last pass, 4 new chunks, and fewer than 3 active hints | Scheduler, priority 4 |
| Pipeline agents | Spec artifacts, held in memory | `POST /api/pipeline/run` | Scheduler, priority 2 |

Models and steering are set in `packages/server/src/config.ts`. Pacing constants sit at the top
of each agent's file.

## Invariants

Each invariant comes from a recorded design decision. Keep it, or record why it moved.

- **One writer per store.** Only the Synthesizer writes the canvas. The Coach appends chat and nothing else. The HintAgent writes hints, which live in `SessionState.hints` beside the canvas instead of inside it. Readers never write the canvas.
- **Concurrent SDK `query()` calls can return empty.** So agents other than the Synthesizer run through `agentScheduler` in `agents/scheduler.ts`, which runs one job at a time. Synthesis has the highest priority because every other agent reads the canvas. A newer hint pass replaces a queued one instead of queueing behind it.
- **One broadcast per batch.** Canvas writes go through `applyCanvasBatch`, so a pass that adds many stickies sends one `canvas.updated`.
- **Every scheduled agent run reports its status.** The scheduler emits `agent.status` as queued, running, done or failed. A failed chat reply shows an error in the chat. A failed assessment shows nothing, because nobody asked a question. Synthesizer runs skip the scheduler, so they emit no `agent.status`, and the Coach's listener for Synthesizer status never fires.
- **Coach prompts stay the same size.** The Coach sees the last 30 transcript chunks, a canvas summary, and a note that says how many earlier lines were left out. Without that note, the model treats the shortened transcript as the whole session.
- **Events only grow.** New `ServerEvent` types are additive. `GET /api/stream` replays current state to each new client, so a new stateful event needs a catch-up line in that route.
- **Mural is a one-way copy.** `SessionMemory` stays the source of truth. A sticky gets its board position once. It moves only when its bounded context changes, or when someone calls `POST /api/mural/tidy`. A Mural failure marks the projector degraded, and the session carries on.
- **Replay and live input exclude each other.** The replay routes return 409 while Zoom is connected. The Zoom webhook refuses a new stream while a replay runs.
- **Spec steps fail loudly.** `runAgentText` retries an empty result. `requireAgentText` then throws if the text is still empty or starts with `API Error`, because the SDK returns transport errors as ordinary text.

## Commands and gotchas

Work from `src/`. The toolchain is Node 22 or later, pnpm 11, and `uv` for Mural only. Scripts are
in each `package.json`.

- The web package has no tests.
- `POST /api/session/hydrate` loads `pipeline/fixtures/finished-session.json` when no snapshot exists. Use it to exercise the pipeline without running a session.

## Environment and secrets

- The `.env` file lives at `src/.env`. `observability/tracing.ts` loads it at startup, and `config.ts` reads the variables.
- Each integration stays off until its variables are set. Langfuse tracing needs `LANGFUSE_*`. Zoom needs `ZOOM_RTMS_ENABLED=true` and the `ZOOM_*` credentials. Mural needs `MURAL_CLIENT_ID` and `MURAL_CLIENT_SECRET`.
- The server writes session snapshots and Mural OAuth tokens under `src/data/`. `src/.gitignore` keeps `.env`, `data/` and build output out of commits.

## What the agents load

`agents/runner.ts` holds the only `query()` call, and it passes `settingSources: []`. So no agent
loads `CLAUDE.md` files, skills, hooks or settings from disk. When the list is omitted, the Agent
SDK loads every source, as a CLI session in `src/` would.

The same call passes `tools: []` and `permissionMode: "dontAsk"`. So an agent can call only the
MCP tools that it passes in `mcpServers` and lists in `allowedTools`. Transcript text reaches every
prompt, and a line spoken in a Zoom meeting must not be able to steer an agent into Bash or into
reading `src/.env`. A new `query()` call outside `runner.ts` therefore needs all three options.

The skills that `SpecStorming.docx` lists live in `steering/` as plain documents:

| Documents | Loaded by |
|---|---|
| `surface-vagueness`, `surface-assumptions` | Coach chat and Coach assessment, through `AGENTS.coach.steering` |
| `assess-domain-model`, `domain-model-quality` | Coach assessment only, through `ASSESSMENT_STEERING` in `CoachAgent.ts`. Chat leaves them out, because their JSON-only reply contract would turn chat answers into JSON. |
| `connect-the-dots`, `find-contradictions`, `surface-constraints` | No agent yet. The docx assigns the first two to the Synthesizer and the Boundary Analyzer, and `surface-constraints` to the Solution Architect. |

## Stale sources

- `README.md` predates hints, the scheduler, Zoom and Mural. Its route table, its model names and its "global mutex" description are out of date. Read `index.ts` and `config.ts` instead.
- The openspec spec `agent-scheduling` requires one `query()` at a time across all agents. The Synthesizer's parallel windows break that rule on purpose (see `runAgentDirect` in `agents/runner.ts`).
- `mcp-mural/.cursor/mcp.json` points at another developer's home directory.

## History

These changes come from `openspec/changes/archive/`. Each change's `design.md` lists the
alternatives that were rejected.

| Archived | Change | Why it was made |
|---|---|---|
| 2026-08-02 | Coach hints | Workshops stalled when nobody noticed a hotspot or a thin area. Hints default to silence, and the server limits how often they appear. |
| 2026-08-02 | Agent responsiveness | A chat reply could wait 90 s behind synthesis, failures only reached the console, and each sticky sent a full-canvas broadcast. The change added the scheduler, `agent.status`, the bounded Coach context and batch canvas writes. |
| 2026-08-08 | Zoom RTMS (Real-Time Media Streams) | A live demo needed real speech instead of replay. RTMS won over a meeting bot because it needs no bot and delivers final utterances with speaker names. The client uses `ws` instead of Zoom's `@zoom/rtms` addon, because the addon hides the sockets that the stub tests drive. |
| 2026-08-08 | Mural projection | The demo needed a spatial board. Board writes later moved from REST to the vendored `mcp-mural`. Its `tool_apply_diagram` tool stays unused, because it brings its own layout engine and widget store. |

Two tasks never closed: a live Zoom rehearsal, and a Mural check with real credentials. Neither
integration has been proven against the real service.

# SpecStorming

**Turn a live EventStorming session into a buildable System Specification — with AI agents doing the synthesis.**

SpecStorming watches a domain-modelling conversation as it happens, continuously builds a
read‑only EventStorming **Canvas** (stickies, hotspots, Bounded Context Canvases), lets you
chat with a **Coach** about gaps and DDD/EventStorming technique, and then runs a multi‑agent
pipeline that produces per‑bounded‑context specs, an architecture/NFR spec, and a final
**System Specification** optimized as input for spec‑driven development.

Built on the [Claude Agent SDK](https://platform.claude.com/docs) (TypeScript).

---

## What it does

### Phase 1 — Live session
A meeting transcript streams in. Two agents share one session memory:

- **Synthesizer** — silently watches the transcript and builds the Canvas via in‑process MCP
  tools: EventStorming stickies (events, commands, actors, policies, read models, external
  systems, aggregates), **hotspots** (contradictions, ambiguities, open questions), and one or
  more **Bounded Context Canvases** (purpose, ubiquitous language, open questions).
- **Coach** — a chat agent you talk to directly. Read‑only; answers questions about the
  conversation, surfaces gaps/vagueness/assumptions, and gives DDD/EventStorming advice,
  grounded in the actual transcript.

### Phase 2 — Post‑session workflows
On the finished session artifact:

- **Boundary Analyzer** — pressure‑tests the discovered boundaries, resolves overlaps, flags
  unresolved conflicts, and emits a per‑bounded‑context specification.
- **Solution Architect** — defines non‑functional requirements (system‑wide + per‑context):
  messaging, resiliency, scaling, consistency, observability.

Each is scored by an **SDD Fitness Evaluator** sub‑agent.

### Phase 3 — Adversarial negotiation
**System Architect** ↔ **Business/Product** agents negotiate (A2A‑style message exchange) and
collaboratively produce the final **System Specification** in a fixed 12‑section format
(business value, system overview, architectural patterns, state/persistence, communication,
system diagram, external integrations, standards, bounded context definitions, service
definitions, functional requirements, non‑functional requirements).

---

## Architecture

```
            transcript chunks (live or replayed)
                          │
                          ▼
                  ┌───────────────┐      EventBus          ┌──────────┐
   ingest ───────▶│ SessionMemory │◀────(transcript.chunk)─│Synthesizer│──┐
 (replayer /      │  (raw inputs  │                        └──────────┘  │ MCP tools
  live source)    │   + Canvas)   │◀──(reads, read-only)──▶┌──────────┐  │ (upsert)
                  └───────┬───────┘                        │  Coach   │  │
                          │  emits ServerEvents            └──────────┘  │
                          ▼                                              ▼
                    SSE  /api/stream  ──────────────▶  React UI (3 panes + Specs overlay)
                          ▲
                          │ POST controls
        ┌─────────────────┴───────────────────────────┐
        │ Phase 2/3 PipelineRunner (on finish/trigger) │
        │  BoundaryAnalyzer → SolutionArchitect →      │
        │  Negotiation(SystemArchitect ↔ Business)     │
        └──────────────────────────────────────────────┘
```

- **`SessionMemory`** is the single shared object both agents reference — “common memory” is
  literally one in‑process object. Raw inputs (transcript, docs) are append‑only; the Canvas is
  written **only** by the Synthesizer.
- **Server → client** uses one **SSE** stream (`/api/stream`); **client → server** uses plain
  `POST` routes.
- All Agent SDK `query()` calls are serialized through a global mutex (concurrent queries can
  return empty), and one synthesis pass runs at a time (debounced).

### Project layout

```
packages/
  shared/   types shared between server & web (canvas, session, pipeline, SSE events)
  server/   Fastify + SSE, SessionMemory, ingest, agents/, pipeline/
  web/      Vite + React UI (TranscriptFeed · Canvas · CoachChat + SpecsPanel)
steering/   always-on domain knowledge composed into agent system prompts
.claude/skills/   Agent Skills (SKILL.md) — loaded live by the Coach; applied via steering by the Synthesizer
```

---

## Prerequisites

- **Node ≥ 22** (developed on Node 26) and **pnpm ≥ 11**
- **Claude authentication.** The Agent SDK runs the Claude Code engine under the hood and uses
  either your logged‑in Claude Code credentials or an API key:
  - Logged in via Claude Code? It just works.
  - Otherwise set `ANTHROPIC_API_KEY` in your environment.

---

## Quick start

```bash
pnpm install          # first run will prompt to allow esbuild's build script — approve it
pnpm dev              # starts the server (:8787) and the web app (:5173)
```

Open **http://localhost:5173** and:

1. Press **▶ Start** — the sample transcript (`acme-orders`) streams in and the Canvas fills
   live as the Synthesizer works (watch stickies, hotspots, and Bounded Contexts appear).
2. Ask the **Coach** a question, e.g. *“What gaps do we have so far?”* — it streams a grounded answer.
3. Press **⏹ Finish**, then **⚙ Generate Specs** to run the Phase 2–3 pipeline. The Specs
   overlay opens and fills in: Bounded Context Specs → Architecture Spec → System Specification.
   Each is downloadable as Markdown.

> Synthesis uses Claude Sonnet and a real model call per batch, so the Canvas fills over a
> couple of minutes; the spec pipeline is a ~10‑minute batch. This is expected.

### Instant demo (skip the wait)

A complete, pre‑synthesized session is committed as a fixture. To load it and jump straight to
spec generation:

```bash
curl -X POST http://localhost:8787/api/session/hydrate   # restores the finished Canvas
curl -X POST http://localhost:8787/api/pipeline/run       # runs Phase 2-3
```

Then open the UI and click **📄 Specs** to watch/inspect the results.

### Useful scripts

```bash
pnpm typecheck        # tsc --noEmit across all packages
pnpm build            # production build
pnpm dev:server       # server only
pnpm dev:web          # web only
```

---

## How the agents are configured

- **Steering** (always‑on domain knowledge) lives in `steering/*.md` and is concatenated into
  each agent’s system prompt. Which docs compose which agent is set in
  `packages/server/src/config.ts`.
- **Skills** (situational techniques) live in `.claude/skills/<name>/SKILL.md`. The Coach loads
  them live (`settingSources: ['project']` + the `Skill` tool); the Synthesizer applies the same
  techniques via steering to keep its live loop fast.
- **Models** are set per agent in `config.ts` (`claude-sonnet-4-6` for both agents — Haiku was
  tried and rejected for synthesis: it missed bounded contexts and contradictions).
- **Pipeline agents** (`packages/server/src/pipeline/`) run with `tools: []` and thinking
  disabled so they return spec text directly, with a retry on empty/short results.

---

## HTTP / SSE API

| Method | Route | Purpose |
|--------|-------|---------|
| `GET`  | `/api/health` | Liveness check |
| `GET`  | `/api/stream` | SSE stream of all server events (catches new clients up on current state) |
| `POST` | `/api/session/replay/start` | Start streaming the sample transcript |
| `POST` | `/api/session/replay/pause` | Pause the replay |
| `POST` | `/api/session/finish` | Mark the session finished + flush a final synthesis pass |
| `POST` | `/api/session/hydrate` | Restore the last snapshot (or the committed fixture) into memory |
| `POST` | `/api/pipeline/run` | Run the Phase 2–3 spec pipeline on the current Canvas |
| `POST` | `/api/coach/message` `{ text }` | Ask the Coach; the reply streams back over SSE |

**Server events** (`ServerEvent` in `packages/shared/src/events.ts`): `hello`, `heartbeat`,
`transcript.chunk`, `canvas.updated`, `coach.delta`, `coach.done`, `synth.status`,
`session.status`, `pipeline.status`, `spec.produced`.

---

## Hooking up live integrations

The demo replays a canned transcript, but the system is **event‑driven off transcript chunks**,
so wiring a real source is a small, well‑isolated change. Everything downstream (Synthesizer,
Coach, Canvas, SSE) reacts automatically once chunks land in `SessionMemory`.

### The one integration seam that matters

Anything that calls **`SessionMemory.appendChunk({ speaker, text })`** drives the entire system.
The sample source is `packages/server/src/ingest/TranscriptReplayer.ts`; replace or supplement it.

### 1. Live meeting transcription (Zoom, Meet, Teams, etc.)

Add an ingestion endpoint and point your transcription source at it:

```ts
// packages/server/src/index.ts
app.post<{ Body: { speaker: string; text: string } }>("/api/ingest/chunk", async (req, reply) => {
  const { speaker, text } = req.body ?? {};
  if (!speaker || !text) return reply.code(400).send({ error: "speaker and text required" });
  memory.appendChunk({ speaker, text });   // → emits transcript.chunk → Synthesizer reacts
  return reply.code(202).send({ ok: true });
});
```

Then connect a transcript producer:
- **Zoom** — use Zoom’s RTMS / live‑transcription webhook (or the Zoom MCP server) to forward
  each caption line to `/api/ingest/chunk`.
- **Google Meet / Teams** — forward their live‑caption events similarly.
- **Local/own STT** — pipe Whisper/Deepgram/AssemblyAI partial‑final segments in as chunks
  (send only *final* segments to avoid churn).

Because the Synthesizer debounces (it runs once enough new chunks accumulate or a short timer
fires), a steady caption stream is fine; you don’t need to batch on the client.

### 2. Shared documents (Docs, diagrams)

`SessionMemory` already models docs (`upsertDoc`) but no ingestion is wired. Add a route that
calls `memory.upsertDoc({ id, title, kind, content, updatedAt })`, and include docs in the
Synthesizer/Coach prompts (see `SynthesizerAgent`/`CoachAgent` prompt construction). A polling
or webhook sync from Google Drive/Notion/Confluence fits here.

### 3. Multiple concurrent sessions

The demo uses a single in‑memory session (`id: "demo"`). To go multi‑tenant, key a `Map<string,
SessionMemory>` by session id, scope the SSE stream and routes to a `:sessionId` param, and
give each session its own `SynthesizerAgent`/`CoachAgent`. The global query mutex in
`runner.ts` already keeps total concurrent SDK calls bounded across sessions.

### 4. Persistence

State is held in memory with a debounced JSON snapshot to `data/sessions/<id>/session.json`
(`packages/server/src/memory/store.ts`). Produced specs are currently kept in the
`PipelineRunner` (memory) and replayed to new SSE clients; persist them alongside the snapshot
if you want them to survive restarts. Swap the JSON store for SQLite/Postgres by replacing
`store.ts` and the `SessionMemory` snapshot hooks.

### 5. Triggering the pipeline automatically

The demo triggers Phase 2–3 manually (**Generate Specs** / `POST /api/pipeline/run`). To run it
automatically when a session ends, call `pipeline.run()` from the `/api/session/finish` handler
after the final synthesis flush.

### 6. Auth & deployment notes

- Set `ANTHROPIC_API_KEY` in the server environment for non‑interactive/hosted runs.
- The server binds `127.0.0.1:8787` by default; override with `HOST` / `PORT`.
- The web dev server proxies `/api` to the server (see `packages/web/vite.config.ts`); in
  production, serve the built `web` and reverse‑proxy `/api` (keep SSE buffering disabled — the
  stream sets `X-Accel-Buffering: no`).
- Spec generation makes many model calls; set budget guardrails (each agent already passes
  `maxBudgetUsd`) and monitor cost.

---

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Server bind address |
| `ANTHROPIC_API_KEY` | — | API key (if not using logged‑in Claude Code credentials) |

Per‑agent steering, skills, and models: `packages/server/src/config.ts`.
Synthesizer pacing (trigger threshold, window, timeout): `packages/server/src/agents/SynthesizerAgent.ts`.
Replay pacing: `packages/server/src/ingest/TranscriptReplayer.ts`.

---

## Notes & known constraints

- **Latency over real‑time fidelity.** Sonnet synthesis passes take tens of seconds; replay is
  paced to let the Canvas keep up. With a live feed, the Canvas trails the conversation slightly
  and catches up — by design.
- **Large single‑turn generations can fail empty.** Spec agents use concise prompts, `tools: []`,
  disabled thinking, condensed inputs, and a retry to stay reliable. Keep new prompts concise.
- **Single session, in‑memory.** Fine for a demo; see “live integrations” to generalize.

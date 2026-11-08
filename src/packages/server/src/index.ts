// Bootstrap OpenTelemetry/Langfuse before importing anything that emits a span.
import { flushTracing, shutdownTracing } from "./observability/tracing.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import type { ServerEvent } from "@specstorming/shared";
import { EventBus } from "./bus/EventBus.ts";
import { z } from "zod";
import { SessionMemory } from "./memory/SessionMemory.ts";
import { TranscriptReplayer } from "./ingest/TranscriptReplayer.ts";
import { ingestChunkSchema } from "./ingest/chunkSchema.ts";
import { LiveSourceStatus } from "./ingest/LiveSourceStatus.ts";
import { ZoomRtmsClient } from "./ingest/zoom/ZoomRtmsClient.ts";
import { handleRtmsEvent } from "./ingest/zoom/dispatch.ts";
import { answerUrlValidation, isPlausiblePlainToken, verifyWebhookSignature } from "./ingest/zoom/webhook.ts";
import { SynthesizerAgent } from "./agents/SynthesizerAgent.ts";
import { CoachAgent } from "./agents/CoachAgent.ts";
import { HintAgent } from "./agents/HintAgent.ts";
import { PipelineRunner } from "./pipeline/orchestrator.ts";
import { agentScheduler } from "./agents/runner.ts";
import { fileSnapshotStore } from "./memory/store.ts";
import { MuralAuth } from "./mural/auth.ts";
import { MuralApiError, MuralMcp } from "./mural/muralMcp.ts";
import { MuralProjector } from "./mural/MuralProjector.ts";
import { restoreMuralBinding } from "./mural/restoreBinding.ts";
import { COACH_CONFIG, HINTS_CONFIG, SERVER_CONFIG, ZOOM_CONFIG } from "./config.ts";

const bus = new EventBus();
// Broadcast every agent-run lifecycle transition (queued/running/done/failed) to clients.
agentScheduler.onLifecycle = (e) => {
  bus.emit({ type: "agent.status", agent: e.agent, state: e.state, detail: e.detail });
};
// The server is the one place that persists the session: SessionMemory writes nothing unless
// given a store, so tests that build one leave the developer's snapshot alone.
const snapshots = fileSnapshotStore(join(SERVER_CONFIG.repoRoot, "data"));
const memory = new SessionMemory(bus, { snapshots });
const liveStatus = new LiveSourceStatus(bus);
const replayer = new TranscriptReplayer(memory);
const zoomClient = new ZoomRtmsClient({
  credentials: { clientId: ZOOM_CONFIG.clientId, clientSecret: ZOOM_CONFIG.clientSecret },
  sink: (chunk) => memory.appendChunk(chunk),
  status: (state, detail) => liveStatus.set(state, detail),
  allowInsecureUrls: ZOOM_CONFIG.allowInsecureUrls,
});
await replayer.load("acme-orders");

const synthesizer = new SynthesizerAgent(memory, bus);
await synthesizer.init();
synthesizer.start();

const coach = new CoachAgent(memory, bus);
if (COACH_CONFIG.enabled) {
  await coach.init();
  coach.start();
}

const hints = new HintAgent(memory, bus);
if (HINTS_CONFIG.enabled) {
  await hints.init();
  hints.start();
}

const pipeline = new PipelineRunner(memory, bus);

/**
 * Generating specs treats the session as complete: stop *starting* background work so the
 * pipeline isn't racing the Synthesizer for the model (it bypasses the scheduler via
 * runAgentDirect) and the Canvas it snapshotted stops moving underneath it. Nothing in flight is
 * cancelled — those runs finish on their own. Background work stays off until the facilitator
 * explicitly restarts replay or resets the session.
 */
function quiesceBackgroundWork(): void {
  replayer.pause();
  synthesizer.suspend();
  hints.suspend();
  coach.suspendAssessments();
}

/** Wake every background producer — the inverse of quiesceBackgroundWork. */
function resumeBackgroundWork(): void {
  synthesizer.resume();
  hints.resume();
  coach.resumeAssessments();
}

const muralAuth = new MuralAuth();
const muralMcp = new MuralMcp(muralAuth);
const muralProjector = new MuralProjector(memory, bus, muralAuth, muralMcp);
muralProjector.start();

// Restore the Mural binding from the last snapshot so the projector survives server
// restarts without the user having to re-bind (see mural/restoreBinding.ts).
{
  const restoredMuralId = await restoreMuralBinding(memory, snapshots, "demo");
  if (restoredMuralId) console.log(`[mural] auto-restored binding to ${restoredMuralId}`);
}

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

/**
 * Single SSE stream. New clients are caught up with the current session state
 * (existing transcript + canvas) before receiving live events.
 */
app.get("/api/stream", (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: ServerEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const state = memory.getState();
  send({ type: "hello", sessionId: state.id, revision: state.revision });
  // Catch up: replay current transcript + canvas so a refresh isn't blank.
  for (const chunk of state.transcript) send({ type: "transcript.chunk", chunk });
  if (state.canvas.lastUpdatedRev > 0) {
    send({ type: "canvas.updated", canvas: state.canvas, revision: state.revision });
  }
  const activeHints = memory.activeHints();
  if (activeHints.length > 0) send({ type: "hints.updated", hints: activeHints });
  send({ type: "session.status", status: state.status });
  const live = liveStatus.latest();
  if (live.state !== "off") send({ type: "live.status", state: live.state, detail: live.detail });
  // Catch up on current agent activity so a mid-synthesis refresh shows the right chips.
  for (const e of agentScheduler.latestStatuses()) {
    send({ type: "agent.status", agent: e.agent, state: e.state, detail: e.detail });
  }
  for (const message of state.coachChat) send({ type: "coach.done", message });
  // Catch up on pipeline progress + any produced specs.
  const pipe = pipeline.getState();
  if (pipe.stage !== "idle") send({ type: "pipeline.status", stage: pipe.stage, detail: pipe.detail });
  for (const artifact of pipe.artifacts) send({ type: "spec.produced", artifact });

  const unsubscribe = bus.subscribe(send);
  const heartbeat = setInterval(() => {
    send({ type: "heartbeat", ts: new Date().toISOString() });
  }, SERVER_CONFIG.heartbeatMs);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---- transcript ingestion ---------------------------------------------------

// Generic producer endpoint: exercises the same seam as Zoom RTMS, and doubles
// as the demo fallback when no live meeting is available.
app.post("/api/ingest/chunk", async (request, reply) => {
  const parsed = ingestChunkSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  }
  const chunk = memory.appendChunk(parsed.data);
  return { id: chunk.id, seq: chunk.seq };
});

// Zoom webhooks need the raw body for signature verification, so this route lives
// in a scoped plugin whose JSON parser keeps the body as a string.
await app.register(async (zoom) => {
  zoom.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  zoom.post("/api/zoom/webhook", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    let event: { event?: string; payload?: { plainToken?: string } };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }
    if (event.event === "endpoint.url_validation") {
      const plainToken = event.payload?.plainToken;
      // Only echo the HMAC for genuine Zoom tokens. Refusing colon-bearing values
      // stops this unauthenticated endpoint being used as a signing oracle to
      // forge webhook signatures (whose preimage is `v0:{ts}:{body}`).
      if (typeof plainToken !== "string" || !isPlausiblePlainToken(plainToken)) {
        return reply.code(400).send({ error: "invalid plainToken" });
      }
      return answerUrlValidation(plainToken, ZOOM_CONFIG.webhookSecretToken);
    }
    const valid = verifyWebhookSignature({
      signature: request.headers["x-zm-signature"] as string | undefined,
      timestamp: request.headers["x-zm-request-timestamp"] as string | undefined,
      rawBody,
      webhookSecretToken: ZOOM_CONFIG.webhookSecretToken,
    });
    if (!valid) return reply.code(401).send({ error: "invalid signature" });
    if (typeof event.event === "string") {
      handleRtmsEvent(event.event, event, {
        enabled: ZOOM_CONFIG.enabled,
        replayRunning: () => replayer.running,
        client: zoomClient,
        status: (state, detail) => liveStatus.set(state, detail),
        log: app.log,
      });
    }
    return { ok: true };
  });
});

// ---- session control routes ------------------------------------------------

app.get("/api/transcripts", async () => ({
  selectedId: replayer.selectedId,
  transcripts: await replayer.list(),
}));

const replaySelectSchema = z.object({
  transcriptId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

app.post<{ Body: { transcriptId?: string } }>("/api/session/replay/select", async (request, reply) => {
  if (liveStatus.connected) {
    return reply.code(409).send({ error: "live source is connected; replay selection is disabled" });
  }
  if (replayer.running || memory.getState().transcript.length > 0) {
    return reply.code(409).send({ error: "reset the session before changing transcripts" });
  }
  const parsed = replaySelectSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "valid transcriptId required" });
  }
  try {
    await replayer.load(parsed.data.transcriptId);
    return { selectedId: replayer.selectedId };
  } catch (error) {
    request.log.warn({ error, transcriptId: parsed.data.transcriptId }, "transcript selection failed");
    return reply.code(404).send({ error: "transcript not found" });
  }
});

app.post("/api/session/replay/start", async (_request, reply) => {
  if (liveStatus.connected) {
    return reply.code(409).send({ error: "live source is connected; replay is disabled" });
  }
  // A hydrate or a spec-pipeline run suspends the agents; starting a replay makes the
  // session live again, so wake them or new chunks are silently ignored.
  resumeBackgroundWork();
  memory.setStatus("live");
  replayer.start();
  if (replayer.done) synthesizer.flush();
  return { running: replayer.running, done: replayer.done };
});

app.post("/api/session/replay/pause", async () => {
  replayer.pause();
  return { running: replayer.running };
});

app.post<{ Body: { seconds?: number } }>("/api/session/replay/window", async (request, reply) => {
  const seconds = request.body?.seconds;
  if (seconds !== 30 && seconds !== 120) {
    return reply.code(400).send({ error: "seconds must be 30 or 120" });
  }
  // Same wake-up as /replay/start: stepping through a window is a way to resume a suspended
  // session, so without this the chunks would stream into a suspended Synthesizer and be lost.
  resumeBackgroundWork();
  memory.setStatus("live");
  replayer.startForSeconds(seconds);
  if (replayer.done) synthesizer.flush();
  return { seconds, running: replayer.running, done: replayer.done };
});

app.post("/api/session/finish", async () => {
  replayer.pause();
  zoomClient.stop("session finished");
  synthesizer.abort(); // cancel in-flight LLM windows; do not start more
  memory.setStatus("finished");
  return { status: "finished" };
});

/**
 * Hard reset — cancels all in-flight LLM calls, clears the canvas/transcript/mural
 * binding, and reloads the default transcript so the session is ready to start again.
 * The client should prompt the user to bind a new (or the same) Mural after this.
 */
app.post("/api/session/reset", async (_request, reply) => {
  // 1. Stop any live ingest. zoomClient.stop() early-returns when no stream is open, so clear
  //    the live-source chip explicitly or a stale one is replayed to the next client.
  replayer.pause();
  zoomClient.stop("session reset");
  liveStatus.set("off", "session reset");

  // 2. Cancel all in-flight synthesizer LLM calls, and clear every agent's suspended flag and
  //    per-session watermarks so a reset after a spec-pipeline run isn't stuck quiesced.
  synthesizer.abort();
  synthesizer.resetState();
  hints.reset();
  coach.reset();

  // 3. Drop the state that lives OUTSIDE SessionState but is still replayed to new SSE clients:
  //    queued agent work built from the old canvas, stale status chips, and the produced specs.
  agentScheduler.reset();
  pipeline.reset();

  // 4. Wipe session state (canvas, transcript, coach chat, mural binding, hints)
  memory.reset();

  // 5. Reload the selected transcript so replay is ready to go again. Keep the facilitator's
  //    choice rather than snapping back to the default.
  try {
    await replayer.load(replayer.selectedId || "acme-orders");
  } catch {
    // non-fatal — user can pick a transcript via /api/replay/select
  }

  // 6. Emitted LAST, deliberately. The web reducer collapses to its initial view on this event,
  //    and that view is exactly the post-reset server state — so emitting here supersedes every
  //    event this handler produced, plus anything a straggling agent emitted during the await
  //    above. Client-side transcript/coachChat/specs only ever append and have no other way to
  //    be dropped.
  bus.emit({ type: "session.reset" });

  return reply.code(200).send({ status: "reset" });
});

// Phase 2–3 spec pipeline (runs on the current synthesized Canvas). Quiesce synchronously,
// before run() serializes the artifact, so no chunk slips in between.
app.post("/api/pipeline/run", async (_request, reply) => {
  // Say so rather than replying 202 to a request that run() silently drops — the Generate Specs
  // button is disabled while busy, but a client working from stale SSE state can still fire.
  if (pipeline.isRunning()) {
    return reply.code(409).send({ accepted: false, reason: "pipeline already running" });
  }
  quiesceBackgroundWork();
  void pipeline.run().finally(() => void flushTracing());
  return reply.code(202).send({ accepted: true });
});

// Restore a finished session into memory (demo "resume" / pre-baked session). Prefers the
// last live snapshot, falling back to the committed fixture so a fresh server can seed it.
app.post("/api/session/hydrate", async (_request, reply) => {
  let snapshot = await snapshots.load("demo");
  if (!snapshot) {
    try {
      const fixture = new URL("./pipeline/fixtures/finished-session.json", import.meta.url);
      snapshot = JSON.parse(await readFile(fixture, "utf-8")) as typeof snapshot;
    } catch {
      snapshot = null;
    }
  }
  if (!snapshot) return reply.code(404).send({ error: "no snapshot" });
  synthesizer.suspendCaughtUp(); // finished session: Canvas already synthesized
  hints.suspend(); // …and there's no live room left to nudge
  memory.hydrate(snapshot);
  synthesizer.suspendCaughtUp();
  return { restored: true, transcript: snapshot.transcript.length };
});

// ---- mural projection --------------------------------------------------------

// OAuth 2.0 + PKCE redirect flow (Mural has no API keys). Tokens stay server-side.
app.get("/api/mural/connect", async (_request, reply) => {
  if (!muralAuth.configured) {
    return reply
      .code(503)
      .send({ error: "Mural app not configured (set MURAL_CLIENT_ID / MURAL_CLIENT_SECRET)" });
  }
  return reply.redirect(muralAuth.beginAuth());
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  "/api/mural/callback",
  async (request, reply) => {
    const { code, state, error } = request.query;
    if (error || !code || !state) {
      // Static message only: `error` is attacker-controllable query input (reflected XSS).
      app.log.warn({ error }, "mural oauth callback failed");
      return reply.code(400).type("text/html").send("<p>Mural authorization failed. Check the server log; you can close this tab.</p>");
    }
    try {
      await muralAuth.handleCallback(code, state);
    } catch (err) {
      app.log.error(err);
      return reply.code(400).type("text/html").send("<p>Mural token exchange failed. Check the server log and retry.</p>");
    }
    return reply.type("text/html").send("<p>✅ Mural connected — you can close this tab and return to Concept-to-Spec.</p>");
  },
);

app.get("/api/mural/status", async () => muralProjector.status());

/** Accept an API mural id ("workspace.12345") or a pasted mural URL
 * (…app.mural.co/t/<team>/m/<workspace>/<boardId>/<share-token>). */
function parseMuralId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]+\.\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/app\.mural\.co\/.*\/m\/([A-Za-z0-9]+)\/(\d+)/);
  if (m) return `${m[1]}.${m[2]}`;
  return null;
}

app.post<{ Body: { muralId?: string } }>("/api/mural/bind", async (request, reply) => {
  const muralId = parseMuralId(request.body?.muralId ?? "");
  if (!muralId) {
    return reply
      .code(400)
      .send({ error: "muralId required — paste the mural's URL or its id (workspace.boardId)" });
  }
  try {
    await muralProjector.bind(muralId);
  } catch (err) {
    const status = err instanceof MuralApiError ? err.status : 500;
    return reply.code(status === 404 ? 404 : 502).send({ error: String(err instanceof Error ? err.message : err) });
  }
  return reply.code(202).send({ bound: true, muralId });
});

// Explicit full-board reflow — the only thing allowed to move already-placed widgets.
app.post("/api/mural/tidy", async (_request, reply) => {
  try {
    return await muralProjector.tidy();
  } catch (err) {
    return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) });
  }
});

// ---- coach hints: engage / dismiss ------------------------------------------

app.post<{ Params: { id: string } }>("/api/hint/:id/dismiss", async (request, reply) => {
  const hint = memory.getHint(request.params.id);
  if (!hint) return reply.code(404).send({ error: "unknown hint" });
  if (!memory.setHintStatus(hint.id, "dismissed")) {
    return reply.code(409).send({ error: `hint is ${hint.status}` });
  }
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/hint/:id/engage", async (request, reply) => {
  const hint = memory.getHint(request.params.id);
  if (!hint) return reply.code(404).send({ error: "unknown hint" });
  if (!memory.setHintStatus(hint.id, "engaged")) {
    return reply.code(409).send({ error: `hint is ${hint.status}` });
  }
  // Record the hint as a facilitator turn so the exchange lives in chat history (and
  // follow-up questions carry it as context), then seed the coach with the fuller prompt.
  memory.appendCoachMessage({
    id: `hint-${hint.id}-${Date.now()}`,
    role: "user",
    text: `💡 ${hint.text}`,
    ts: new Date().toISOString(),
  });
  const canvas = memory.getState().canvas;
  const target = hint.targetId
    ? [...canvas.stickies, ...canvas.hotspots, ...canvas.boundedContexts].find(
        (el) => el.id === hint.targetId,
      )
    : undefined;
  const seed = [
    `The facilitator engaged one of your hints (${hint.kind}): "${hint.text}"`,
    target ? `It concerns this canvas element: ${hint.targetId} — ${"text" in target ? target.text : target.name}` : "",
    "",
    hint.prompt,
    "",
    "Give concrete, actionable guidance the facilitator can act on right now.",
  ]
    .filter(Boolean)
    .join("\n");
  void coach
    .ask(seed)
    .catch((err) => app.log.error(err))
    .finally(() => void flushTracing());
  return reply.code(202).send({ accepted: true });
});

app.post<{ Body: { text?: string } }>("/api/coach/message", async (request, reply) => {
  const text = request.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text required" });
  // Record the facilitator's message, then stream the Coach's reply over SSE.
  memory.appendCoachMessage({
    id: `user-${Date.now()}`,
    role: "user",
    text,
    ts: new Date().toISOString(),
  });
  void coach
    .ask(text)
    .catch((err) => app.log.error(err))
    .finally(() => void flushTracing());
  return reply.code(202).send({ accepted: true });
});

const start = async () => {
  try {
    await app.listen({ port: SERVER_CONFIG.port, host: SERVER_CONFIG.host });
    app.log.info(`Concept-to-Spec server on http://${SERVER_CONFIG.host}:${SERVER_CONFIG.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Flush buffered Langfuse spans on shutdown so no traces are lost.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    coach.stop();
    muralProjector.stop();
    void shutdownTracing().finally(() => process.exit(0));
  });
}

void start();

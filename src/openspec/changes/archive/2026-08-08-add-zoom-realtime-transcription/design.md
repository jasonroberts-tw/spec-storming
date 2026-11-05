# Design: add-zoom-realtime-transcription

## Context

All transcript ingestion flows through one seam: `SessionMemory.appendChunk({speaker, text, ts?})` (`packages/server/src/memory/SessionMemory.ts:62`), which assigns `id`/`seq`, emits `transcript.chunk` on the EventBus, and triggers the synthesizer (6-chunk / 12s trigger, 10-chunk window). The only producer today is `TranscriptReplayer` (canned sample, ~3s/chunk). The server is a single-session Fastify 5 app (`id = "demo"`), loopback-bound by default, with SSE fan-out at `GET /api/stream`. There is no websocket, webhook, or Zoom code anywhere; `ws` is not a dependency. The README (lines 184–224) sketches exactly this integration.

Zoom RTMS (Real-Time Media Streams) delivers live meeting transcript data to an app backend: a `meeting.rtms_started` webhook carries `meeting_uuid`, `rtms_stream_id`, and `server_urls`; the app opens a signaling WebSocket, authenticates with an HMAC-SHA256 signature built from client id/secret + meeting UUID + stream id, receives a media server URL, opens the media WebSocket subscribed to the transcript media type, and answers keep-alives. `meeting.rtms_stopped` signals teardown. Webhook endpoints must answer Zoom's `endpoint.url_validation` challenge and verify `x-zm-signature` on every event.

## Goals / Non-Goals

**Goals:**
- Live Zoom meeting speech appears as transcript chunks in the demo session with real speaker names, driving the existing synthesizer/coach/hints pipeline unchanged.
- The live path is testable without Zoom via `POST /api/ingest/chunk`.
- The facilitator can see live-source state (waiting / connected / disconnected) and cannot accidentally double-feed the session with replay + live simultaneously.
- Credentials/config via env vars; a demo runbook covers tunnel + Zoom app setup.

**Non-Goals:**
- Multi-session / multi-meeting support (server stays single-session; first active stream wins).
- Audio or video RTMS streams, recording, or our own STT — transcript data type only.
- Partial-caption rendering (interim results); we ingest final utterances only.
- Production-grade OAuth app lifecycle (marketplace publication, deauthorization flows).

## Decisions

1. **Zoom RTMS over alternatives.** Considered: (a) a Meeting SDK bot joining as a participant (heavyweight, needs its own runtime and audio pipeline + STT), (b) third-party bot APIs like Recall.ai (fast but paid external dependency, transcript quality varies), (c) Zoom's Closed Captioning API (wrong direction — it pushes captions *into* Zoom). RTMS is Zoom-native, botless, low-latency, and hands us finalized transcript text with speaker attribution — the shortest path to a credible live demo.

2. **One RTMS transcript message → one `appendChunk` call, no aggregation in v1.** RTMS transcript payloads are finalized per speaker turn, which maps naturally onto our chunk shape (`speaker` = participant display name, `text` = utterance, `ts` = payload timestamp). No interim/partial filtering complexity beyond ignoring non-transcript message types. If real meetings produce utterances too rapid-fire for the synthesizer's 10-chunk window, add same-speaker coalescing later (risk noted below) — not speculatively now.

3. **`ws` package for the client WebSockets.** Two outbound sockets (signaling + media) per stream. `ws` is the boring, battle-tested choice; Node's built-in client `WebSocket` global is version-sensitive and we don't control the demo machine's Node minor version. Fastify needs no websocket *server* plugin — Zoom connects to us only via HTTPS webhooks. *Considered at implementation time:* Zoom's official `@zoom/rtms` npm SDK (v1.1.0) abstracts the whole handshake, but it's a native addon (darwin-arm64/linux-x64 only, Node ≥22) and hides the socket layer we need for stub-server testing — kept hand-rolled; revisit if the handshake proves brittle in the live rehearsal.

4. **Webhook route on the existing Fastify app** (`POST /api/zoom/webhook`), not a separate process/port. Handles `endpoint.url_validation` (HMAC of `plainToken` with the webhook secret token), verifies `x-zm-signature` + timestamp on all other events, and dispatches `meeting.rtms_started`/`meeting.rtms_stopped` to the RTMS client. One process keeps the demo operationally simple; reachability is solved by a tunnel (ngrok/cloudflared) + `HOST=0.0.0.0`, documented in the runbook.

5. **A `ZoomRtmsClient` class in `src/ingest/zoom/`, symmetric with `TranscriptReplayer`.** Owns the socket lifecycle: handshake, transcript subscription, keep-alive replies, bounded exponential-backoff reconnect while the meeting is live, teardown on `rtms_stopped` or explicit stop. It calls `memory.appendChunk()` and emits live-status changes; it does not touch agents or SSE directly.

6. **Live-source status as a new additive SSE event `live.status`** (`{ state: "off" | "waiting" | "connected" | "disconnected", detail? }`), broadcast on transitions and included in the `GET /api/stream` catch-up burst like other stateful events. Client renders it in `SessionControls`. Additive to the shared event union — no existing event changes.

7. **Mutual exclusion between replay and live by rejection, not arbitration.** While the live source is `connected`, `POST /api/session/replay/start` returns 409; while replay is running, an incoming `rtms_started` is refused (logged + surfaced as `live.status` detail). Simple, predictable, and the facilitator resolves conflicts manually — no auto-pause magic to debug mid-demo.

8. **`POST /api/ingest/chunk` validates `{speaker, text, ts?}` with zod** (already a server dependency) and calls the same `appendChunk` seam. It is always enabled; it doubles as the fallback demo path if Zoom/tunnel fails on the day.

9. **Config in `config.ts` + `.env`**: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN`, gated by `ZOOM_RTMS_ENABLED` (default off). Env loading already happens via `tracing.ts`'s `process.loadEnvFile` side effect at first import — no dotenv needed. `.env.example` documents the new vars.

## Risks / Trade-offs

- [Zoom-side payload/field drift — RTMS message schemas and handshake constants must match current Zoom docs] → Verify field names against the official RTMS reference and Zoom's sample code at implementation time; keep all Zoom protocol knowledge inside `src/ingest/zoom/` so corrections are localized.
- [Webhook unreachable during demo (tunnel drops, URL misconfigured)] → `live.status` makes failure visible immediately; `POST /api/ingest/chunk` + replay remain as rehearsed fallbacks; runbook includes a pre-demo webhook validation check.
- [Account/app entitlement: RTMS must be enabled for the Zoom account and app scopes granted] → Runbook lists exact app type, scopes, and account toggles; test end-to-end days before the demo, not the morning of.
- [Rapid-fire utterances exceed the synthesizer's 10-chunk window, so some chunks are never synthesized] → Acceptable for v1 (synthesizer window advances by processed seq; coach/hints still see full transcript). If observed in rehearsal, add same-speaker coalescing in the RTMS client.
- [Reconnect storms or duplicate transcript delivery after resume] → Bounded backoff with jitter; dedupe by tracking the last-seen RTMS timestamp per speaker and dropping older-or-equal messages after reconnect.
- [Secrets in a hackathon repo] → Secrets only via `.env` (gitignored); `.env.example` carries placeholders.

## Migration Plan

Additive feature, default off (`ZOOM_RTMS_ENABLED` unset → server behaves exactly as today). Demo rollout: enable flag → start tunnel → configure webhook URL in Zoom app → start meeting with RTMS → verify `live.status: connected`. Rollback = unset flag and restart; replay path is untouched.

## Open Questions

- Does the demo Zoom account have RTMS enabled, and which app type (general app with RTMS scopes) will we register? (Blocks nothing in code; blocks the live rehearsal.)
- Should `meeting.rtms_stopped` auto-finish the session (flush synthesizer, status `finished`) or leave that to the facilitator's Finish button? v1: facilitator-manual; revisit after first rehearsal.

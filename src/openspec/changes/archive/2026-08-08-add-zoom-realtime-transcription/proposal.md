# Proposal: add-zoom-realtime-transcription

## Why

Today the only transcript producer is `TranscriptReplayer`, which paces a canned sample file at ~3s/chunk — great for rehearsed demos, but the product story is a *live* workshop. Integrating Zoom's real-time transcription lets us run a genuine live demo: people talk in a Zoom meeting and stickies, hotspots, and hints appear on the canvas as they speak. The README already names this as the intended next step (`POST /api/ingest/chunk` + Zoom RTMS); this change makes it real.

## What Changes

- Add a **Zoom RTMS (Real-Time Media Streams) client** to the server: receive Zoom webhook events for meeting/RTMS lifecycle, complete the signaling + media WebSocket handshake, subscribe to the live transcript data stream, and validate webhook signatures.
- Add a **live transcript ingestion path** that maps Zoom transcript messages (final utterances only, with real speaker names) onto the existing single ingestion seam `SessionMemory.appendChunk()` — downstream synthesizer/coach/hints/SSE behavior is unchanged.
- Add a **generic HTTP ingest endpoint** (`POST /api/ingest/chunk`) so the live path can be exercised without a Zoom meeting (curl, scripts, other STT producers) and used as a demo fallback.
- Add **live-source controls and status**: the facilitator can see whether a live source is connected (Zoom connected / disconnected / waiting) and the replay controls coexist safely with live ingestion (no interleaved double-feeding by default).
- Add Zoom app credentials to server config/env handling (`.env`, `.env.example`) and document the tunnel/`HOST=0.0.0.0` requirement for webhook delivery.

No breaking changes: replay mode, session snapshots, and all agent behavior remain as-is.

## Capabilities

### New Capabilities

- `zoom-rtms-connection`: Establishing and maintaining the Zoom side — webhook endpoint (URL validation + signature verification), RTMS signaling/media WebSocket handshake, transcript stream subscription, keep-alive, reconnect, and teardown on meeting end.
- `live-transcript-ingestion`: Translating live transcript events into session transcript chunks — finals-only filtering, speaker attribution, ordering, and the generic `POST /api/ingest/chunk` endpoint feeding the same seam.
- `live-session-controls`: Facilitator visibility and control of the live source — connection status surfaced over SSE and in the header UI, guarding against replay + live double-feeding, and finishing a live session cleanly.

### Modified Capabilities

_None — existing capability requirements (agent scheduling, status visibility, canvas coalescing, coach responsiveness, hints) are untouched; live chunks flow through the same contract as replayed chunks._

## Impact

- **Server** (`packages/server`): new `src/ingest/zoom/` module (webhook route, RTMS client), new ingest route, small additions to `src/index.ts` route wiring and `src/config.ts` (Zoom credentials, feature flag); new `ws` dependency for the RTMS WebSocket client.
- **Shared** (`packages/shared`): new SSE event type for live-source status (additive to the event union).
- **Web** (`packages/web`): live-source status indicator in `SessionControls`; no canvas/chat changes.
- **Ops/demo setup**: requires a Zoom account with an RTMS-enabled app (client id/secret + webhook secret token), a public tunnel (e.g. ngrok) to reach the webhook, and `HOST=0.0.0.0`.
- **Agents**: none — synthesizer pacing assumptions (6-chunk trigger, 10-chunk window) hold because only final utterances are ingested.

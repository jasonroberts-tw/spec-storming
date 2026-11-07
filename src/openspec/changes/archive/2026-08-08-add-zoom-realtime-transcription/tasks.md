# Tasks: add-zoom-realtime-transcription

## 1. Foundation: config, events, ingest endpoint

- [x] 1.1 Add `ws` dependency to `packages/server`; add `ZOOM_CONFIG` (clientId, clientSecret, webhookSecretToken, enabled flag from `ZOOM_RTMS_ENABLED`) to `packages/server/src/config.ts` and document the new vars in `.env.example`
- [x] 1.2 Add `live.status` event (`{ state: "off" | "waiting" | "connected" | "disconnected", detail? }`) to the shared event union in `packages/shared/src/events.ts` and track current live status in server state so catch-up can replay it
- [x] 1.3 Implement `POST /api/ingest/chunk` with zod validation (`speaker`/`text` non-empty strings, optional ISO `ts`), returning the created chunk's id/seq on 200 and a validation message on 400
- [x] 1.4 Verify by curl: valid POST appends a chunk (visible via SSE and synthesizer trigger), invalid POST returns 400 and leaves the transcript unchanged

## 2. Zoom webhook endpoint

- [x] 2.1 Verify current RTMS webhook/handshake payload shapes against Zoom's official RTMS docs and sample code; record the message-type constants and field names used in `src/ingest/zoom/`
- [x] 2.2 Implement `POST /api/zoom/webhook`: answer `endpoint.url_validation` with plainToken + HMAC-SHA256 encryptedToken; verify `x-zm-signature`/timestamp on all other events and reject invalid signatures without side effects
- [x] 2.3 Dispatch `meeting.rtms_started` / `meeting.rtms_stopped` from the webhook to the RTMS client (no-op with a log when `ZOOM_RTMS_ENABLED` is off)
- [x] 2.4 Unit-test the validation challenge and signature verification (valid, invalid, missing header) with fixed secrets

## 3. RTMS client

- [x] 3.1 Implement `ZoomRtmsClient` in `packages/server/src/ingest/zoom/ZoomRtmsClient.ts`: signaling handshake (HMAC signature from client credentials + meeting UUID + stream id), media socket connect, transcript subscription, keep-alive replies
- [x] 3.2 Map finalized transcript messages to `memory.appendChunk({speaker, text, ts})`; ignore non-transcript message types; suppress duplicates after reconnect via last-seen timestamp per speaker
- [x] 3.3 Implement lifecycle: emit `live.status` transitions (waiting → connected → disconnected/off), bounded exponential-backoff reconnect with jitter while the meeting is live, full teardown (close sockets, cancel retries) on `rtms_stopped` or explicit stop without auto-finishing the session
- [x] 3.4 Unit-test the transcript-message mapping and duplicate suppression with fabricated RTMS payloads (no live Zoom needed)

## 4. Mutual exclusion and session wiring

- [x] 4.1 Guard `POST /api/session/replay/start` to return 409 while the live source is connected; refuse `rtms_started` while replay is running and broadcast a `live.status` with an explanatory detail
- [x] 4.2 Hook the finish action: stopping the session while live stops RTMS ingestion before the synthesizer flush; include current `live.status` in the `/api/stream` catch-up burst
- [x] 4.3 Verify end-to-end without Zoom: simulate `rtms_started`/transcript/`rtms_stopped` against a stub RTMS server (local `ws` instance) and confirm chunks, status events, and exclusion behavior

## 5. Web client indicator

- [x] 5.1 Handle `live.status` in `packages/web/src/api/useSessionStream.ts` state reducer
- [x] 5.2 Render a live-source indicator in `SessionControls` (distinct connected / waiting / disconnected treatments) and disable the replay start button while live is connected
- [x] 5.3 Verify in the browser against the stub flow from 4.3 (indicator transitions without reload)

## 6. Demo runbook and quality gates

- [x] 6.1 Write `docs/zoom-rtms-demo.md` runbook: Zoom app creation (type, RTMS scopes, account entitlement), webhook secret + URL configuration, tunnel setup (`HOST=0.0.0.0` + ngrok/cloudflared), pre-demo validation checklist, and fallbacks (ingest endpoint, replay)
- [x] 6.2 Run quality gates: `tsc --noEmit` across packages, server tests, and confirm replay-only behavior is unchanged with `ZOOM_RTMS_ENABLED` off
- [ ] 6.3 Live rehearsal: real Zoom meeting end-to-end (speech → canvas), record any payload-shape corrections back into `src/ingest/zoom/`

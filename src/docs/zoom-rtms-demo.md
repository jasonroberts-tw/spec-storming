# Zoom RTMS Live Transcription — Demo Runbook

Streams live Zoom meeting speech into the SpecStorming session: people talk, the
transcript feed fills, and the synthesizer builds the canvas in real time. The
integration is off by default (`ZOOM_RTMS_ENABLED` unset) and replay mode is
untouched.

## 1. Zoom account + app setup (do this days before the demo)

RTMS must be turned on in **three independent places** — A (the app), B (the
account), and C (auto-start). If any one is missing, `meeting.rtms_started`
never fires and nothing reaches the server. Zoom's console wording shifts
between portal versions, so the exact labels below are approximate; the
structure is what matters.

**A. Create and configure the app.** In the
[Zoom App Marketplace](https://marketplace.zoom.us/) → **Develop → Build App**,
create a **General App** (user-managed OAuth).

- **Basic Information** → copy **Client ID** and **Client Secret** →
  `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`.
- **OAuth** → the build flow requires a Redirect URL and OAuth allow-list entry
  even though this integration performs no user-OAuth at runtime. Set both to an
  HTTPS URL you control (your tunnel URL from section 3 is fine) so the app can
  be added to the account.
- **Scopes** → add `meeting:read:meeting_transcript`. Audio/video scopes are not
  needed.
- **Features → Real-Time Media Streams** → enable the RTMS feature for the app.
  For an **unpublished/development** app this usually requires Zoom to grant RTMS
  entitlement for your specific App ID — request it on the
  [Zoom Developer Forum](https://devforum.zoom.us/) (search "enable RTMS for App
  ID") and allow a few days. Until this is granted the app will not appear in the
  account's auto-start list (step C).
- **Features → Event Subscriptions** → add a subscription, set its notification
  URL (section 3), and subscribe to the two events **Meeting → RTMS Started**
  (`meeting.rtms_started`) and **Meeting → RTMS Stopped**
  (`meeting.rtms_stopped`). Copy the subscription's **Secret Token** →
  `ZOOM_WEBHOOK_SECRET_TOKEN`. This is a *distinct* value from the Client Secret.
- **Add** the app to your own account (the "Add"/Local Test button for an
  unpublished app) so the host user who runs the meeting is authorized.

**B. Enable RTMS on the account** (admin required). Zoom web portal →
**Settings → Zoom Apps** → turn on Real-Time Media Streams (look for the "apps
that access shared real-time meeting content" area). This can be set at the
account, group, or user level.

**C. Set the app to auto-start** (same Zoom Apps settings area). In
"Automatically start apps that access shared meeting content", select your app
and set **Auto-start = On**. **This is mandatory, not optional:** the server only
*receives* an already-running stream — it never calls Zoom's RTMS start API — so
if auto-start is off, RTMS never starts and no webhook fires. If your app is
missing from this dropdown, its RTMS feature/entitlement from step A isn't fully
granted yet.

## 2. Server configuration

Add to `.env` at the repo root (see `.env.example`):

```
ZOOM_RTMS_ENABLED=true
ZOOM_CLIENT_ID=<from app credentials>
ZOOM_CLIENT_SECRET=<from app credentials>
ZOOM_WEBHOOK_SECRET_TOKEN=<from event subscription>
HOST=0.0.0.0
```

`HOST=0.0.0.0` is required — the default binds loopback only and the tunnel
can't reach it.

## 3. Tunnel + webhook URL

Zoom delivers webhooks over public HTTPS, so the **API server on port 8787** must
be reachable from the internet. Tunnel **8787** — the Fastify API server — **not**
the web app on 5173. The browser UI stays local (`http://localhost:5173`); only
Zoom's webhook needs the tunnel.

```sh
ngrok config add-authtoken <your-ngrok-token>   # one-time; `ngrok http` fails without it
ngrok http 8787                                 # or: cloudflared tunnel --url http://localhost:8787
```

ngrok prints a forwarding URL like `https://abc123.ngrok-free.app`. Your webhook
URL is that host with the route path appended:

```
https://abc123.ngrok-free.app/api/zoom/webhook
```

Paste that into the app's **Event Subscription** notification URL (section 1A)
and click **Validate** — the server answers Zoom's `endpoint.url_validation`
challenge automatically, and the field must go green before events flow.
Free-tier ngrok URLs change on every restart, so update the notification URL and
re-validate whenever you restart the tunnel.

**The tunnel only carries the webhook.** Transcript data does *not* flow through
ngrok — once a stream starts, the server dials Zoom directly over **outbound**
`wss://*.zoom.us` WebSocket connections (the SSRF allowlist enforces this host).
Those need no inbound tunnel and are unaffected by ngrok restarts mid-meeting.

## 4. Running the demo

1. Start the stack: `pnpm dev` (server 8787 + web 5173), tunnel up, URL validated.
2. Start the Zoom meeting as the authorized host. With auto-start configured
   (section 1C), Zoom starts RTMS and fires `meeting.rtms_started` a few seconds
   in — no manual step in the meeting. (If nothing happens, RTMS auto-start or
   the app's RTMS entitlement isn't fully set up; recheck section 1.)
3. Watch the header: **zoom waiting…** → **🔴 zoom live**. Speak — utterances
   appear in the transcript feed with real speaker names and the synthesizer
   picks them up like replayed chunks.
4. While live, replay ▶ Start is disabled (server returns 409) so the canned
   transcript can't interleave with the meeting.
5. End: click **⏹ Finish** in the UI (stops ingestion, flushes the synthesizer,
   marks the session finished) — or end the meeting, which tears down the
   stream but leaves the session live.

## 5. Pre-demo validation checklist

- [ ] `curl -s localhost:8787/api/health` → ok, and `.env` has all four ZOOM vars.
- [ ] App RTMS entitlement granted, and the app shows in the account's RTMS
      auto-start list with **Auto-start = On** (else `rtms_started` never fires).
- [ ] Tunnel points at **8787**; Zoom Event Subscription URL validated (green) today.
- [ ] Stub rehearsal passes against the running server (no Zoom needed):
      `cd packages/server && npx tsx scripts/rtms-stub-demo.ts`
      — expect `signature ok`, `replay/start while live: 409`, 4 transcript
      lines in the UI, clean stop. (Requires the server started with the same
      ZOOM_* values the script uses, **plus `ZOOM_RTMS_ALLOW_INSECURE_URLS=true`**
      so the client will dial the local `ws://127.0.0.1` stub — this flag must be
      **off** for the real demo, which only allows `wss://*.zoom.us`.)
- [ ] Real Zoom meeting smoke test: join, speak one sentence, see it in the feed.
- [ ] Fallbacks rehearsed (below).

## 6. Fallbacks if Zoom fails on the day

- **Generic ingest endpoint** (always on, no Zoom needed) — pipe any text in:
  ```sh
  curl -X POST localhost:8787/api/ingest/chunk \
    -H 'content-type: application/json' \
    -d '{"speaker":"Maya","text":"Payment failures spike on Mondays"}'
  ```
- **Replay mode**: ▶ Start plays the canned `acme-orders` transcript exactly as
  before this integration.

## 7. Known protocol caveats (verify at first rehearsal)

Recorded in `packages/server/src/ingest/zoom/protocol.ts`; Zoom's own docs
disagree in three places, and the code takes the majority reading:

- Webhook payload fields: handled both flat (`payload.*`) and nested
  (`payload.object.*`).
- Transcript `media_type` bitmask: 8. If the data handshake fails with status
  7/14 (logged), try 16.
- Transcript messages are assumed finalized utterances; if a real meeting shows
  the same sentence growing across messages (partials), add same-speaker
  coalescing in `ZoomRtmsClient.handleMediaMessage`.

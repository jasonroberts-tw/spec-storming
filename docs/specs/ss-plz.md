# Receive a live transcript from a Microsoft Teams meeting

**Written:** 2026-11-10, from the trunk at commit `cc7ae6e`.
**Status:** Intent confirmed 2026-11-11, by the operator at Gate 1. No design is written yet.

This spec wins over `src/openspec/specs/` where the two disagree about a Teams meeting. The code
wins over this spec about what the product does today.

Feature issue: `ss-plz`. This spec holds the feature's intent. The `design` skill extends it after
the spike `ss-8tl` reports.

## Use case

As a facilitator, I want the speech of a Microsoft Teams meeting to reach my session as it is
spoken, so that the canvas and the Coach follow a workshop that a client hosts on Teams.

The facilitator pastes the meeting's join link into the web app. A visible guest, the notetaker,
joins the meeting and receives Teams' own live captions. Each final caption becomes one transcript
chunk.

This is one feature: one actor, the facilitator, and one goal.

Two existing specs cover part of this, and the feature changes what they say:

- `src/openspec/specs/live-session-controls/spec.md` § "Requirement: Replay and live source are
  mutually exclusive" and § "Requirement: Live-source status event" speak of one live source.
- `src/openspec/specs/live-transcript-ingestion/spec.md` § "Requirement: RTMS transcript messages
  become transcript chunks" describes ingestion in Zoom's terms only.

### Non-goals

- Any change to an agent, a prompt or a pacing constant.
- Partial captions, in storage or on screen.
- Translated captions.
- A notice posted in the meeting's chat.
- Capturing audio, and speech-to-text of our own.
- A third-party service that processes the meeting's audio or text.
- Webinars, town halls, live events, end-to-end-encrypted meetings, breakout rooms, and Teams for
  personal use.
- More than one session, or more than one transcript source at a time.
- Finishing the session automatically when the meeting ends.
- Rejoining by itself after a participant removes or denies the notetaker.
- Changing the caption language while connected. The facilitator disconnects and connects again.
- Joining from a calendar invitation.
- Running the server on Linux or Windows.
- Meetings longer than 2 hours or with more than 10 participants.
- Fixing `ss-e4x` and deciding `ss-q3q`, which were found while planning this feature.

## Acceptance criteria

Connecting:

- AC-TL-1: Given Teams is configured and no transcript source is running, when the facilitator
  submits a Teams join link and a caption language, then the notetaker asks to join that meeting
  and the web app shows the Teams source as waiting.
- AC-TL-2: Given the facilitator has not chosen a language, when the connect form is shown, then
  `en-us` is preselected.
- AC-TL-3: Given the notetaker asks to join, then its display name in the lobby and the roster says
  that captions are recorded.
- AC-TL-4: Given the notetaker is waiting, when a participant admits it and captions start in the
  chosen language, then the web app shows the Teams source as connected.
- AC-TL-5: Given the submitted text is not a Teams meeting join link, when the facilitator submits
  it, then the server refuses it with a message, and nothing joins any meeting.
- AC-TL-6: Given Teams is not configured on the server, when a connect is attempted, then the
  server refuses it with a message that says Teams is not configured.

Transcript:

- AC-TL-7: Given the Teams source is connected, when Teams issues a final caption, then exactly one
  transcript chunk is appended with the caption's text, the caption's time and the speaker's
  display name.
- AC-TL-8: Given the Teams source is connected, when Teams issues a partial caption, then no
  transcript chunk is appended.
- AC-TL-9: Given a final caption carries no speaker name, then its transcript chunk's speaker is
  the label "Unknown speaker".
- AC-TL-10: Given a transcript chunk came from Teams, then it is emitted as the same
  `transcript.chunk` event, with the same fields, as a replayed chunk.

One source at a time:

- AC-TL-11: Given a replay is running or Zoom is connected, when the facilitator submits a Teams
  join link, then the server refuses it, the web app shows why, and nothing joins the meeting.
- AC-TL-12: Given the Teams source is waiting or connected, when a replay start, a replay window
  or a replay selection is requested, then the server refuses it with 409 and appends no chunk.
- AC-TL-13: Given the Teams source is waiting or connected, when a Zoom stream starts, then the
  server refuses it, and the web app shows that Zoom was refused and why.
- AC-TL-14: Given any live source changes state, then the web app names the source, Zoom or Teams,
  beside the state.
- AC-TL-15: Given the Teams source is in any state other than off, when a browser connects to the
  event stream, then it shows the current source and state.
- AC-TL-16: Given Zoom is the live source, when a Zoom stream starts, delivers utterances and
  stops, then chunks are appended as they are today.

When things go wrong:

- AC-TL-17: Given the notetaker has waited 15 minutes without being admitted, then it leaves the
  lobby, the web app shows that nobody admitted it, and the session stays live.
- AC-TL-18: Given a participant denies the notetaker from the lobby or removes it from the meeting,
  then it does not ask to join again by itself, the web app shows what happened, and the session
  stays live.
- AC-TL-19: Given the Teams source is connected, when the network connection drops, then the web
  app shows the source as disconnected and the notetaker tries to return by itself.
- AC-TL-20: Given the notetaker returned after a drop, then no caption received before the drop is
  appended a second time.
- AC-TL-21: Given the notetaker has joined, when captions cannot be started, then it leaves the
  meeting and the web app says that captions were unavailable.
- AC-TL-22: Given the meeting ends, then the web app shows the Teams source as disconnected, and
  the session stays live until the facilitator finishes it.

Stopping:

- AC-TL-23: Given the Teams source is waiting or connected, when the facilitator disconnects it,
  then the notetaker leaves the lobby or the meeting, the source shows as off, and the session
  keeps its transcript and canvas and stays live.
- AC-TL-24: Given the Teams source is waiting or connected, when the facilitator finishes or resets
  the session, then the notetaker leaves the lobby or the meeting.
- AC-TL-25: Given the facilitator disconnected the Teams source, when they submit a join link
  again, then AC-TL-1 holds again.

Proof against the real service:

- AC-TL-26: Given a Teams meeting that a tenant other than the server's own organises, when the
  facilitator connects, a participant admits the notetaker and two people speak, then AC-TL-4 and
  AC-TL-7 hold in that meeting. The operator checks this by hand.
- AC-TL-27: Given a meeting of 2 hours with 10 participants, then the Teams source stays connected
  and chunks keep arriving until the meeting ends. The operator checks this by hand.
- AC-TL-28: Given the setup runbook for Teams, then it has a step in which the facilitator tells
  the participants aloud that captions are being recorded.

## Dependencies

| The feature needs | State today |
|---|---|
| An Azure subscription | The operator has one. |
| An Azure Communication Services (ACS) resource in it | Does not exist yet. The operator creates it. |
| The ACS Web Calling SDK, `@azure/communication-calling` | Not accepted. Its licence is "Microsoft Software License Terms". The operator reads it before any install (`AGENTS.md` § "Delivery workflow", New dependencies). |
| A way to drive a browser from the server, and Chrome on the facilitator's Mac | Not chosen. Design chooses it after the spike. |
| A second Microsoft 365 tenant that can host a Teams meeting | Does not exist yet. The operator creates a trial tenant. |
| The organiser's Teams policies allow an anonymous guest and live captions | Outside our control. AC-TL-17, AC-TL-18 and AC-TL-21 say what happens when they do not. |
| The finding of spike `ss-8tl` | Not started. It waits on the three operator steps above. |
| A product glossary, `ss-495` | Not written. This spec uses its terms: utterance, transcript chunk, live source, notetaker. |

Two defects found while planning touch the same code. Design says whether this feature closes
them: `ss-du4` (the replay window has no live guard, which AC-TL-12 covers for Teams) and `ss-4zz`
(a refused live source is never shown, which AC-TL-11 and AC-TL-13 cover).

## Answers

Each row is a question put to the operator and the operator's answer. Rows 1 to 22 were answered on
2026-11-09, and rows 23 to 28 on 2026-11-10.

| # | Question | Answer |
|---|---|---|
| 1 | Is the feature limited to ingestion, with the agents unchanged? | Ingestion only. |
| 2 | Whose Teams meetings must it work in? | Any tenant, including a client's. |
| 3 | May a visible participant join the meeting? | Yes. |
| 4 | May a third party process the audio or the transcript? | No. Microsoft and own code only. |
| 5 | Must every utterance carry the speaker's real name? | Names when the source gives them. |
| 6 | How does the facilitator bind a session to a meeting? | By pasting the join link in the web app. |
| 7 | May several transcript sources run at once? | No. One at a time. |
| 8 | Is a live rehearsal in a second tenant's meeting required for done? | Yes. |
| 9 | Are the four mismatches between the live-session code and its spec fixed here? | No. They are filed separately, and this feature fixes only what it needs. |
| 10 | Which words name the spoken unit and the stored unit? | Utterance and transcript chunk. "Line" is retired. |
| 11 | Where do decisions and the glossary live? | `docs/decisions/`, and `src/GLOSSARY.md` with a root `GLOSSARY-MAP.md`. |
| 12 | Does the session finish when the meeting ends? | No. It stays live until the facilitator finishes it. |
| 13 | Which mechanism? | ACS Teams captions, received by a headless browser that the server drives. |
| 14 | Prototype before design? | Yes. |
| 15 | Is Azure and a second tenant available? | Azure yes. The operator creates a trial tenant. |
| 16 | A shared live-source contract, with Zoom moved onto it? | Yes, with one shared exclusivity guard and a `source` field on `live.status`. |
| 17 | What if the prototype fails? | Two working days, one retry with a visible browser, then stop and report. |
| 18 | Which captions are stored? | Final captions only, one transcript chunk each. |
| 19 | How are participants told? | The notetaker's display name says so, and the facilitator announces it aloud. No chat message. |
| 20 | Is the calling SDK's licence accepted? | Not yet. The operator reads the terms first. |
| 21 | Where is the caption language chosen? | In the web app at connect, with `en-us` preselected. |
| 22 | Where does the browser run? | As a child process of the server, on the same machine. |
| 23 | How long does the notetaker wait in the lobby? | 15 minutes, then it leaves and says so. |
| 24 | Does the notetaker rejoin by itself? | After a network drop, yes. After a removal, never. |
| 25 | What if captions cannot start? | The notetaker leaves and says why. |
| 26 | Can the facilitator disconnect without finishing? | Yes. |
| 27 | What size of meeting? | Up to 2 hours and 10 participants. |
| 28 | Which platform? | The facilitator's macOS laptop only. |

Left for Design, because each depends on the spike's finding:

- The delay allowed between speech and its transcript chunk.
- How many times, and for how long, the notetaker retries after a network drop.
- The exact wording of the notetaker's display name.

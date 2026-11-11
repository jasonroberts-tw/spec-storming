# Receive a live transcript from a Microsoft Teams meeting

**Written:** 2026-11-10, from the trunk at commit `cc7ae6e`.
**Status:** Intent confirmed 2026-11-11, by the operator at Gate 1, after a review changed the first
draft. Rows 13, 16 and 22 of the Answers are three design decisions the operator took early. The
rest of the design is not written, and no decision record exists yet.

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

### Where the transcript goes

Capturing the meeting uses Microsoft's services and this repository's code, and nothing else.

After capture, a transcript chunk from Teams is treated as every transcript chunk is. It goes into
agent prompts. Those prompts go to the model provider the server is configured with, and to the
tracing service when tracing is on. `docs/ARCHITECTURE.md` § "System context" names both as they
are today. This spec names neither, because the operator requires that the product not depend on
one provider. The epic `ss-ebu` carries that requirement, and it does not block this feature.

### Existing specs this feature changes

- `src/openspec/specs/live-session-controls/spec.md` § "Requirement: Live-source status event"
  speaks of one live source. So do
  `src/openspec/specs/live-session-controls/spec.md` § "Requirement: Live-source indicator in the facilitator UI",
  `src/openspec/specs/live-session-controls/spec.md` § "Requirement: Replay and live source are mutually exclusive"
  and `src/openspec/specs/live-session-controls/spec.md` § "Requirement: Finishing a live session".
- `src/openspec/specs/live-transcript-ingestion/spec.md` § "Requirement: RTMS transcript messages become transcript chunks"
  and `src/openspec/specs/live-transcript-ingestion/spec.md` § "Requirement: Duplicate suppression after reconnect"
  describe ingestion in Zoom's terms only.
- `src/openspec/specs/zoom-rtms-connection/spec.md` § "Requirement: RTMS stream connection on meeting start"
  names the cases in which a Zoom stream is refused. AC-TL-13 adds one.

### Non-goals

- Any change to an agent, a prompt or a pacing constant.
- Choosing or changing the model provider or the tracing service. `ss-ebu` carries that.
- Partial captions, in storage or on screen.
- Translated captions.
- A notice posted in the meeting's chat.
- Capturing audio, and speech-to-text of our own.
- A third-party service that captures the meeting: one that joins it, or that turns its speech into
  text.
- Webinars, town halls, live events, end-to-end-encrypted meetings, breakout rooms, and Teams for
  personal use.
- More than one session.
- A replay and a live source at the same time, or two live sources at the same time.
- Finishing the session automatically when the meeting ends.
- Rejoining by itself after a participant removes or denies the notetaker.
- Changing the caption language while connected. The facilitator disconnects and connects again.
- Joining from a calendar invitation.
- A disconnect control for Zoom. Finish and reset stop Zoom, as they do today.
- Running the server on Linux or Windows.
- Meetings longer than 2 hours, or with more than 10 participants besides the notetaker.
- Fixing `ss-e4x` and deciding `ss-q3q`, which were found while planning this feature.

## Acceptance criteria

A live source is in one of four states, which the web app shows:

| State | Meaning |
|---|---|
| off | The source is not trying to do anything. |
| waiting | It was asked to connect, and is not yet delivering. For Teams, the notetaker has asked to join. |
| connected | It is delivering final captions or utterances. |
| disconnected | It lost its connection, and is trying to return by itself. |

A source is **active** in every state except off. Every ending puts the source to off, with a reason.

Connecting:

- AC-TL-1: Given Teams is configured, no replay is running and no live source is active, when the
  facilitator submits a Teams join link and a caption language, then the notetaker asks to join
  that meeting and the web app shows the Teams source as waiting.
- AC-TL-2: Given the facilitator has not chosen a language, when the connect form is shown, then
  `en-us` is preselected.
- AC-TL-3: Given the notetaker asks to join, then its display name in the lobby and the roster says
  that captions are recorded and that an AI service processes them.
- AC-TL-4: Given the notetaker is waiting, when it is in the meeting and captions have started in
  the chosen language, then the web app shows the Teams source as connected. This holds whether a
  participant admitted the notetaker or the meeting let it pass the lobby.
- AC-TL-5: Given the submitted text is not a Teams meeting join link, when the facilitator submits
  it, then the server refuses it with a message, and nothing joins any meeting.
- AC-TL-6: Given Teams is not configured on the server, when a connect is attempted, then the
  server refuses it with a message that says Teams is not configured.
- AC-TL-29: Given the meeting does not allow an anonymous guest, when the notetaker asks to join,
  then the Teams source goes off and the web app says that the meeting refused the guest.

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

One at a time:

- AC-TL-11: Given a replay is running or Zoom is active, when the facilitator submits a Teams join
  link, then the server refuses it, the web app shows why, and nothing joins the meeting.
- AC-TL-12: Given the Teams source is active, when a replay start, a replay window or a replay
  selection is requested, then the server refuses it with 409 and appends no chunk.
- AC-TL-13: Given the Teams source is active or a replay is running, when a Zoom stream starts,
  then the server refuses it, and the web app shows that Zoom was refused and why.
- AC-TL-30: Given Zoom is active, when a replay start, a replay window or a replay selection is
  requested, then the server refuses it with 409 and appends no chunk.
- AC-TL-32: Given a live source is active, then the web app disables its replay start, replay
  window and transcript selection controls.
- AC-TL-14: Given any live source changes state, then the web app names the source, Zoom or Teams,
  beside the state.
- AC-TL-31: Given a live source was refused, or went off for a reason other than the facilitator's
  own disconnect, finish or reset, then the web app shows the source and the reason until a live
  source next becomes active or the session resets.
- AC-TL-15: Given a live source is active, or is off with a reason still shown, when a browser
  connects to the event stream, then it shows the same source, state and reason.
- AC-TL-16: Given Zoom is the live source, when a Zoom stream delivers final utterances, then one
  transcript chunk is appended for each, as
  `src/openspec/specs/live-transcript-ingestion/spec.md` § "Requirement: RTMS transcript messages become transcript chunks"
  says. An utterance with no name keeps Zoom's label, "Zoom".
- AC-TL-34: Given Zoom has stopped trying to connect or to return, then the Zoom source is off with
  the reason shown, and it no longer refuses a replay or a Teams connect.

When things go wrong:

- AC-TL-17: Given the notetaker has waited 15 minutes without getting into the meeting, then it
  leaves the lobby, the Teams source goes off, the web app shows that nobody admitted it, and the
  session stays live.
- AC-TL-18: Given a participant denies the notetaker from the lobby or removes it from the meeting,
  then it does not ask to join again by itself, the Teams source goes off, the web app shows what
  happened, and the session stays live.
- AC-TL-19: Given the Teams source is connected, when the network connection drops, then the web
  app shows the source as disconnected, the notetaker tries to return by itself, and the source
  stays active.
- AC-TL-33: Given the notetaker could not return after a drop, then the Teams source goes off and
  the web app says that the connection was lost.
- AC-TL-20: Given the notetaker returned after a drop, then no caption received before the drop is
  appended a second time.
- AC-TL-21: Given the notetaker has joined, when captions cannot be started, then it leaves the
  meeting, the Teams source goes off, and the web app says that captions were unavailable.
- AC-TL-22: Given the meeting ends, then the Teams source goes off, the web app shows that the
  meeting ended, and the session stays live until the facilitator finishes it.

Stopping:

- AC-TL-23: Given the Teams source is active, when the facilitator disconnects it, then the
  notetaker leaves the lobby or the meeting and stops trying to return, the source goes off, and
  the session keeps its transcript and canvas and stays live.
- AC-TL-24: Given the Teams source is active, when the facilitator finishes or resets the session,
  then the notetaker leaves the lobby or the meeting and stops trying to return, and the source
  goes off.
- AC-TL-25: Given the Teams source is off, for any reason, when the facilitator submits a join link
  again, then AC-TL-1 holds again.

Proof against the real service:

- AC-TL-26: Given a Teams meeting whose organising tenant has given this product no consent and
  has nothing of it installed, when the facilitator connects, the notetaker gets in and two people
  speak, then AC-TL-4 and AC-TL-7 hold in that meeting. The operator checks this by hand.
- AC-TL-27: Given a meeting of 2 hours with 10 participants besides the notetaker, then the Teams
  source stays connected and chunks keep arriving until the meeting ends. The operator checks this
  by hand.
- AC-TL-28: Given the setup runbook for Teams, then it has a step in which the facilitator tells
  the participants aloud that captions are being recorded and that an AI service processes them.

## Dependencies

| The feature needs | State today |
|---|---|
| An Azure subscription | The operator has one. |
| An Azure Communication Services (ACS) resource in it | Does not exist yet. The operator creates it. |
| ACS to stay available for joining Teams meetings | Microsoft announced on 2026-09-23 that ACS retires as a standalone offering on 2028-09-30. Its guide keeps Teams meeting interoperability as a supported use, and lists the calling SDK and captions as "Breaking change" with the note "SDK change; applicable Teams license". Design reads the guide before it picks an SDK version: `https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide`. |
| The ACS Web Calling SDK, `@azure/communication-calling` | Not accepted. Its licence is "Microsoft Software License Terms". The operator reads it before any install (`AGENTS.md` § "Delivery workflow", New dependencies). |
| A package that mints the notetaker's access token, `@azure/communication-identity` | Not installed. Its licence is MIT. |
| A way to drive a browser from the server, and Chrome on the facilitator's Mac | Not chosen. Design chooses it after the spike. |
| A second Microsoft 365 tenant that can host a Teams meeting | Does not exist yet. The operator creates a trial tenant. |
| The organiser's Teams policies allow an anonymous guest and live captions | Outside our control. AC-TL-29 says what happens when the guest is refused, and AC-TL-21 when captions are. |
| A model provider and, optionally, a tracing service | Whatever the server is configured with. This feature changes neither. |
| The finding of spike `ss-8tl` | Not started. It waits on the operator's three steps: the licence, the ACS resource and the trial tenant. |
| A product glossary, `ss-495` | Not written. The operator fixed two of its terms, utterance and transcript chunk. This spec also uses two that are still proposals: live source and notetaker. |

**What is not verified.** Every statement here about Microsoft's services comes from Microsoft's
pages, read on 2026-11-09 and 2026-11-11, and not from this repository. Three of those pages say
an ACS guest receives Teams captions, and one says the calling SDK does not support them. Microsoft
documents nothing about running the SDK in a browser with no person at it. The spike `ss-8tl` tests
both before Design builds on them.

Two of the three defects filed while planning touch the same code. This feature's criteria cover
what each one asks for, and each stays open until a story that meets those criteria closes it:

- `ss-du4`, the replay window has no live guard: AC-TL-12, AC-TL-30 and AC-TL-32.
- `ss-4zz`, a refused live source is never shown: AC-TL-11, AC-TL-13, AC-TL-31 and AC-TL-15.

## Answers

Each row is a question put to the operator and the operator's answer. Rows 1 to 22 were answered on
2026-11-09, rows 23 to 28 on 2026-11-10, and rows 29 to 35 on 2026-11-11.

| # | Question | Answer |
|---|---|---|
| 1 | Is the feature limited to ingestion, with the agents unchanged? | Ingestion only. |
| 2 | Whose Teams meetings must it work in? | Any tenant, including a client's. |
| 3 | May a visible participant join the meeting? | Yes. |
| 4 | May a third party process the audio or the transcript? | "Microsoft and own code only." Row 33 says what this covers. |
| 5 | Must every utterance carry the speaker's real name? | Names when the source gives them. |
| 6 | How does the facilitator bind a session to a meeting? | By pasting the join link in the web app. |
| 7 | May a replay and a live source, or two live sources, run at once? | No. One at a time. Row 35 says from when. |
| 8 | Is a live rehearsal in a second tenant's meeting required for done? | Yes. |
| 9 | Are the four findings about the live-session code fixed here? | No. They are filed separately, and this feature fixes only what it needs. |
| 10 | Which words name the spoken unit and the stored unit? | Utterance and transcript chunk. "Line" is retired. |
| 11 | Where do decisions and the glossary live? | `docs/decisions/`, and `src/GLOSSARY.md` with a root `GLOSSARY-MAP.md`. |
| 12 | Does the session finish when the meeting ends? | No. It stays live until the facilitator finishes it. |
| 13 | Which mechanism? | ACS Teams captions, received by a headless browser that the server drives. |
| 14 | Prototype before design? | Yes. |
| 15 | Is Azure and a second tenant available? | Azure yes. The operator creates a trial tenant. |
| 16 | A shared live-source contract, with Zoom moved onto it? | Yes, with one shared exclusivity guard and a `source` field on `live.status`. |
| 17 | What if the prototype fails? | Two working days, one retry with a visible browser, then stop and report. |
| 18 | Which captions are stored? | Final captions only, one transcript chunk each. |
| 19 | How are participants told? | The notetaker's display name says so, and the facilitator announces it aloud. No chat message. Row 34 adds what the notice says. |
| 20 | Is the calling SDK's licence accepted? | Not yet. The operator reads the terms first. |
| 21 | Where is the caption language chosen? | In the web app at connect, with `en-us` preselected. |
| 22 | Where does the browser run? | As a child process of the server, on the same machine. |
| 23 | How long does the notetaker wait in the lobby? | 15 minutes, then it leaves and says so. |
| 24 | Does the notetaker rejoin by itself? | After a network drop, yes. After a removal, never. |
| 25 | What if captions cannot start? | The notetaker leaves and says why. |
| 26 | Can the facilitator disconnect without finishing? | Yes. |
| 27 | What size of meeting? | Up to 2 hours and 10 participants. |
| 28 | Which platform? | The facilitator's macOS laptop only. |
| 29 | Which label does a caption with no speaker name get? | "Unknown speaker", as proposed. |
| 30 | Is a denial from the lobby treated like a removal? | Yes, as proposed. |
| 31 | Are joining from a calendar invitation and changing the language while connected left out? | Yes, as proposed. |
| 32 | Are the criteria the session proposed, which no other row records, accepted? | Yes. The operator confirmed the criteria as written. |
| 33 | Transcript text already reaches the model provider and, when on, the tracing service. Does row 4 cover that? | "The tool must be provider agnostic." Row 4 covers capture only. This spec names no provider. Provider choice is separate work, `ss-ebu`, and does not block this feature. |
| 34 | Does the notice say that an AI service processes the captions? | Yes, in the display name and in the spoken announcement. |
| 35 | From when does a live source block the others, and how does it end? | From the moment it is asked to connect until it is off, including while it waits or retries, for Teams and for Zoom. Every ending sets it to off with the reason shown. |

Left for Design, because each depends on the spike's finding:

- The delay allowed between speech and its transcript chunk.
- How many times, and for how long, the notetaker retries after a network drop.
- The exact wording of the notetaker's display name.
- How exactly the web app can name why the notetaker left. That depends on which reasons Teams
  reports.
- Whether row 18 stands. Microsoft describes a final caption as one sentence, so a Teams transcript
  chunk can be shorter than an utterance, and the agents pace themselves by counting chunks. The
  spike measures real captions, and the operator decides at Gate 2.
- How Zoom's present states map onto row 35, which AC-TL-34 requires.

# live-session-controls

## Purpose

Give the facilitator visibility and control of the live source — connection status surfaced over SSE and in the UI, guarding against replay and live ingestion double-feeding the transcript at the same time, and finishing a live session cleanly.

## Requirements

### Requirement: Live-source status event
The server SHALL broadcast a `live.status` SSE event whenever the live source changes state, carrying a state of `off`, `waiting`, `connected`, or `disconnected` and an optional human-readable detail. The most recent live status SHALL be included in the SSE catch-up burst for newly connected clients.

#### Scenario: Status transitions are broadcast
- **WHEN** the RTMS client completes its handshake for a started meeting
- **THEN** all connected clients receive `live.status` with state `connected`

#### Scenario: Catch-up includes live status
- **WHEN** a client connects to `/api/stream` while the live source is connected
- **THEN** the catch-up burst includes a `live.status` event with state `connected`

### Requirement: Live-source indicator in the facilitator UI
The web client SHALL display the current live-source state in the session controls area, visually distinguishing connected (live), waiting, and disconnected states, without requiring a page reload.

#### Scenario: Indicator reflects connection
- **WHEN** a `live.status` event with state `connected` arrives
- **THEN** the session controls show a live indicator; when a later event reports `disconnected`, the indicator changes accordingly

### Requirement: Replay and live source are mutually exclusive
The server SHALL refuse to start transcript replay while the live source is connected, and SHALL refuse an incoming live stream while replay is running, surfacing the refusal to the facilitator.

#### Scenario: Replay blocked during live meeting
- **WHEN** the live source is `connected` and the facilitator POSTs `/api/session/replay/start`
- **THEN** the server responds 409 without starting replay and the transcript receives no replayed chunks

#### Scenario: Live stream refused during replay
- **WHEN** replay is running and a `meeting.rtms_started` event arrives
- **THEN** no RTMS connection is established and a `live.status` event explains that the live source was refused because replay is active

### Requirement: Finishing a live session
The existing finish action SHALL work while the live source is active: finishing SHALL stop live ingestion, flush the synthesizer, and mark the session finished.

#### Scenario: Finish during live meeting
- **WHEN** the facilitator finishes the session while the live source is connected
- **THEN** RTMS ingestion stops, no further chunks are appended, the synthesizer flush runs, and session status becomes `finished`

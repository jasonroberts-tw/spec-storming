# live-transcript-ingestion

## Purpose

Translate live transcript events into session transcript chunks — finals-only filtering, speaker attribution, ordering, duplicate suppression across reconnects, and a generic `POST /api/ingest/chunk` endpoint that feeds the same ingestion seam as replay and the Zoom RTMS client.

## Requirements

### Requirement: RTMS transcript messages become transcript chunks
The system SHALL map each finalized RTMS transcript message to exactly one transcript chunk via the existing ingestion seam, with `speaker` set to the Zoom participant's display name, `text` set to the utterance text, and `ts` derived from the message timestamp. Non-transcript RTMS message types MUST NOT produce chunks.

#### Scenario: Live utterance appears as a chunk
- **WHEN** a connected RTMS media socket delivers a finalized transcript message for participant "Maya" with text "Payment failures spike on Mondays"
- **THEN** a transcript chunk with speaker "Maya" and that text is appended to the session, emitted as `transcript.chunk`, and flows to the synthesizer and SSE clients exactly like a replayed chunk

#### Scenario: Non-transcript messages ignored
- **WHEN** the media socket delivers keep-alive or non-transcript data messages
- **THEN** no transcript chunk is appended

### Requirement: Duplicate suppression after reconnect
After an RTMS reconnection, the system SHALL NOT append a chunk for a transcript message whose content was already ingested before the connection loss.

#### Scenario: Replayed message after resume
- **WHEN** the client reconnects and receives a transcript message identical (same speaker, text, and timestamp no newer than the last ingested for that speaker) to one already ingested
- **THEN** the message is dropped and no duplicate chunk appears in the transcript

### Requirement: Generic chunk ingestion endpoint
The server SHALL expose `POST /api/ingest/chunk` accepting a JSON body with required non-empty `speaker` and `text` strings and an optional ISO `ts`, appending a chunk through the same seam. Invalid bodies MUST be rejected with a 400 and a validation message, and MUST NOT append a chunk.

#### Scenario: Valid chunk ingested via HTTP
- **WHEN** a client POSTs `{"speaker": "Sam", "text": "Refunds go through finance"}` to `/api/ingest/chunk`
- **THEN** the server responds 200 with the created chunk's id and seq, and the chunk is broadcast to SSE clients and counted toward synthesizer triggering

#### Scenario: Invalid body rejected
- **WHEN** a client POSTs a body missing `text` or with an empty `speaker`
- **THEN** the server responds 400 with a validation error and the transcript is unchanged

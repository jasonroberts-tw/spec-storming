# coach-responsiveness

## ADDED Requirements

### Requirement: Immediate pending indicator on submit
The web client SHALL display a pending assistant response (thinking indicator) immediately when the user submits a coach message, before any server response arrives.

#### Scenario: Pending bubble appears instantly
- **WHEN** the user submits a coach message
- **THEN** an assistant bubble in a pending/thinking state appears in the chat without waiting for the first streamed token

#### Scenario: Pending bubble transitions to streaming
- **WHEN** the first `coach.delta` for the reply arrives
- **THEN** the pending bubble becomes the streaming reply and accumulates subsequent deltas

### Requirement: Bounded coach prompt context
The coach agent SHALL build its prompt from a bounded context — a fixed-size window of recent transcript chunks plus a compact structural canvas summary — rather than the full transcript and full canvas, so prompt size does not grow with session length.

#### Scenario: Long session keeps bounded prompt
- **WHEN** the session transcript exceeds the transcript window size
- **THEN** the coach prompt includes only the most recent window of chunks plus the canvas summary, and prompt size is independent of total session length

### Requirement: Coach failure is shown in the chat
If a coach run fails (timeout, abort, or agent error), the client SHALL replace the pending/streaming bubble with a visible error state instead of leaving the indicator forever.

#### Scenario: Timed-out coach request
- **WHEN** a coach run fails before completing its reply
- **THEN** the chat shows an error state for that reply and the user can submit again

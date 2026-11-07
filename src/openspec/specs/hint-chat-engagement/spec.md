# hint-chat-engagement Specification

## Purpose
Turn an engaged hint into a seeded coach chat exchange: append a hint-derived message to the chat history, invoke the coach with the hint's engagement prompt, retire the hint across clients, and support follow-up conversation.

## Requirements

### Requirement: Engaging a hint seeds a coach conversation
When a facilitator engages a hint, the system SHALL start a coach exchange seeded from that hint: a chat message derived from the hint SHALL be appended to the coach chat history (so the exchange is visible in the conversation), and the coach SHALL be invoked with the hint's pre-authored engagement prompt plus the context of its target canvas element.

#### Scenario: Engagement produces a seeded exchange
- **WHEN** the facilitator engages an `active` hint
- **THEN** a message derived from the hint appears in the coach chat history and the coach begins responding to the hint's topic

#### Scenario: Coach response streams normally
- **WHEN** the coach responds to an engaged hint
- **THEN** the response streams to clients through the same delta and completion events as a typed coach question

### Requirement: Engagement updates hint status
Engaging a hint SHALL set its status to `engaged` before or as the coach is invoked, and all connected clients SHALL be notified so the hint leaves the active display everywhere.

#### Scenario: Hint retired across clients on engage
- **WHEN** one client engages a hint
- **THEN** every connected client receives a hints update in which that hint is no longer `active`

### Requirement: Engagement of invalid hints is rejected
The system SHALL reject engagement or dismissal requests for hints that do not exist or are not `active`, without invoking the coach or altering chat history.

#### Scenario: Engaging an already-dismissed hint
- **WHEN** a client requests engagement of a hint whose status is `dismissed`
- **THEN** the request is rejected with an error status and no coach exchange is started

### Requirement: Engaged conversation supports follow-up
After a hint-seeded coach response completes, the facilitator SHALL be able to continue the conversation with normal typed messages, with the hint exchange present in the chat history the coach receives.

#### Scenario: Follow-up question after an engaged hint
- **WHEN** the facilitator sends a typed message after a hint-seeded response
- **THEN** the coach receives the prior hint exchange as part of the chat history and answers in that context

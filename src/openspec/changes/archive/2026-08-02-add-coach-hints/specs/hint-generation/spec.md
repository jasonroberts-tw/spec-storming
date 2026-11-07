# hint-generation Specification

## ADDED Requirements

### Requirement: Proactive hint generation from workshop state
The system SHALL proactively generate hints — unprompted guidance about the workshop — from the current session state (recent transcript, canvas stickies/bounded contexts/hotspots, and coach chat history) without any user request. Each hint SHALL have a kind from: `discuss-hotspot`, `clarify-ambiguity`, `go-broader`, `go-deeper`, `next-topic`; a short display text; a pre-authored engagement prompt; optional reference to the canvas element it concerns (`targetId`); and optional transcript provenance (`sourceChunkIds`).

#### Scenario: Hint generated for an undiscussed hotspot
- **WHEN** the canvas contains a hotspot that has not been discussed in recent transcript chunks and a hint pass runs
- **THEN** the system generates an `active` hint of kind `discuss-hotspot` whose `targetId` references that hotspot and whose text invites the group to discuss it

#### Scenario: No hint when nothing is useful
- **WHEN** a hint pass runs and the session state offers no genuinely useful guidance
- **THEN** the pass produces zero hints and no event is emitted

### Requirement: Hint rate limiting and cap
The system SHALL rate-limit hint generation so hints arrive occasionally rather than constantly: hint passes MUST be debounced behind session activity, MUST NOT run more often than a configured minimum interval, and the number of `active` hints MUST NOT exceed a configured cap (default 3).

#### Scenario: Cap prevents additional hints
- **WHEN** the number of `active` hints equals the cap and a hint pass would produce a new hint
- **THEN** the new hint is not added until an existing hint is engaged or dismissed

#### Scenario: Minimum interval between passes
- **WHEN** a hint pass completed less than the minimum interval ago and new session activity occurs
- **THEN** no new hint pass starts until the minimum interval has elapsed

### Requirement: Hint deduplication and staleness pruning
The system SHALL NOT re-suggest a topic the facilitator dismissed during the session, and SHALL remove `active` hints whose target canvas element no longer exists.

#### Scenario: Dismissed topic not re-suggested
- **WHEN** a hint has been dismissed and a later hint pass considers the same topic
- **THEN** no new hint with that topic is created for the remainder of the session

#### Scenario: Hint pruned when target disappears
- **WHEN** the canvas element referenced by an `active` hint's `targetId` is removed from the canvas
- **THEN** the hint is removed from the active set and clients are notified

### Requirement: Hint lifecycle
Each hint SHALL have exactly one status: `active`, `engaged`, or `dismissed`. Only `active` hints SHALL be displayed. Status transitions SHALL be: `active → engaged` (facilitator engages it in chat) and `active → dismissed` (facilitator dismisses it); transitions out of `engaged` or `dismissed` MUST NOT occur.

#### Scenario: Engaging a hint retires it
- **WHEN** a facilitator engages an `active` hint
- **THEN** its status becomes `engaged` and it is no longer displayed as active

### Requirement: Hint persistence and replay
Hints SHALL be part of the persisted session state and SHALL be replayed to clients on stream connect, so a newly connected client sees the same active hints as existing clients.

#### Scenario: Late-joining client receives active hints
- **WHEN** a client connects to the session stream while there are `active` hints
- **THEN** the catch-up sequence includes the current hints and the client renders them

### Requirement: Hint generation does not modify the canvas
Hint generation SHALL NOT create, modify, or delete canvas stickies, bounded contexts, or hotspots; the synthesizer remains the sole writer of canvas content.

#### Scenario: Hint pass leaves canvas untouched
- **WHEN** a hint pass completes
- **THEN** the canvas revision and all canvas content are unchanged by that pass

# coach-responsiveness

## Purpose

Keep the coach chat feeling immediate: instant pending feedback on submit, bounded prompt context so replies stay fast in long sessions, a rate-limited proactive review that never crowds out interactive work, and visible error states when an interactive run fails.

## Requirements

### Requirement: Immediate pending indicator on submit
The web client SHALL display a pending assistant response (thinking indicator) immediately when the user submits a coach message, before any server response arrives.

#### Scenario: Pending bubble appears instantly
- **WHEN** the user submits a coach message
- **THEN** an assistant bubble in a pending/thinking state appears in the chat without waiting for the first streamed token

#### Scenario: Pending bubble transitions to streaming
- **WHEN** the first `coach.delta` for the reply arrives
- **THEN** the pending bubble becomes the streaming reply and accumulates subsequent deltas

### Requirement: Bounded coach prompt context
Every coach prompt — the interactive reply and the proactive assessment alike — SHALL include at most a fixed-size window of the most recent transcript chunks, annotated with the number of earlier lines omitted, so prompt size does not grow with session length.

The two paths differ in how much canvas they carry. The interactive reply SHALL use a compact structural canvas summary. The proactive assessment MAY include the full canvas, because it scores bounded-context detail (ubiquitous language, business decisions, assumptions, open questions, cross-context communication) that the compact summary omits, and because the canvas is bounded by model size rather than by session length.

#### Scenario: Long session keeps bounded prompt
- **WHEN** the session transcript exceeds the transcript window size
- **THEN** the interactive coach prompt includes only the most recent window of chunks plus the canvas summary, and prompt size is independent of total session length

#### Scenario: Long session keeps the assessment prompt bounded
- **WHEN** a proactive assessment runs on a session whose transcript exceeds the transcript window size
- **THEN** the assessment prompt includes only the most recent window of chunks plus a note naming how many earlier lines were omitted, and its size is independent of total session length

### Requirement: Minimum interval between proactive assessments
Proactive assessments SHALL be rate-limited by a configured minimum interval measured from the end of the previous assessment, so that continuous session activity cannot chain deep reviews back to back. Evidence that arrives inside the interval SHALL be deferred and reviewed once the interval elapses, not dropped.

#### Scenario: Continuous activity does not chain reviews
- **WHEN** transcript chunks and canvas revisions arrive continuously after a proactive assessment completes
- **THEN** no further assessment starts until the minimum interval has elapsed

#### Scenario: Deferred evidence is still reviewed
- **WHEN** new evidence arrives less than the minimum interval after the previous assessment completed and no further evidence arrives afterward
- **THEN** an assessment covering that evidence runs once the interval elapses

#### Scenario: First review of a session is not delayed
- **WHEN** a session is reset and new evidence arrives
- **THEN** the first proactive assessment is not held back by any interval carried over from the previous session

### Requirement: Coach failure is shown in the chat
If an interactive coach run fails (timeout, abort, or agent error), the client SHALL replace the pending/streaming bubble with a visible error state instead of leaving the indicator forever. A failed proactive assessment SHALL NOT produce a chat error, because the user did not ask a question.

#### Scenario: Timed-out coach request
- **WHEN** an interactive coach run fails before completing its reply
- **THEN** the chat shows an error state for that reply and the user can submit again

#### Scenario: Failed assessment leaves the chat alone
- **WHEN** a proactive assessment run fails
- **THEN** the chat shows no error state and the previously displayed assessment feedback is retained

# agent-scheduling

## Purpose

Serialize and prioritize Agent SDK runs across all server-side agents (synthesizer, coach, pipeline, assessment, hints) so that canvas synthesis and interactive work are never starved by background passes.

## Requirements

### Requirement: Single-flight agent execution
The system SHALL execute at most one Agent SDK `query()` call at a time across all agents (synthesizer, coach, pipeline, assessment, hints).

#### Scenario: Overlapping submissions do not interleave
- **WHEN** two agent runs are submitted while another run is executing
- **THEN** the executing run completes before either submitted run starts, and the submitted runs execute one at a time

### Requirement: Priority ordering of pending work
The scheduler SHALL dequeue pending agent runs in priority order — synthesizer, then the interactive coach, then pipeline, then the proactive assessment, then hints — and FIFO within the same priority class.

Synthesis ranks highest because the canvas is the input every other agent reads, so starving it degrades all of them. The interactive coach ranks above the remaining classes because a user is waiting on the reply. The proactive assessment and hint passes are background work and yield to everything else.

#### Scenario: Synthesis is never starved by a background review
- **WHEN** a proactive assessment is pending and a synthesizer pass is then submitted
- **THEN** the synthesizer pass executes first

#### Scenario: Coach jumps the queue
- **WHEN** a synthesizer pass is executing, a hint pass is pending, and a coach request is then submitted
- **THEN** the coach request executes immediately after the current synthesizer pass completes, before the pending hint pass

#### Scenario: Interactive and proactive coach work are ranked separately
- **WHEN** a proactive assessment and an interactive coach request are both pending
- **THEN** the interactive coach request executes first

#### Scenario: FIFO within a class
- **WHEN** two coach requests are pending
- **THEN** they execute in submission order

### Requirement: Hint runs are deferred, not dropped
A hint pass whose gating conditions are satisfied SHALL be enqueued at hint priority and executed when no higher-priority work is pending, instead of being skipped because another agent holds the lock.

#### Scenario: Hint pass runs after busy period
- **WHEN** a hint pass is submitted while the synthesizer is executing and no further work is pending afterward
- **THEN** the hint pass executes after the synthesizer pass completes

#### Scenario: At most one queued hint pass
- **WHEN** a hint pass is already pending and a newer hint pass is submitted
- **THEN** the pending hint pass is replaced by the newer one, leaving exactly one queued hint job

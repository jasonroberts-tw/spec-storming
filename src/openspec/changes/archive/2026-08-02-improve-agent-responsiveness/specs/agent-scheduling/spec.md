# agent-scheduling

## ADDED Requirements

### Requirement: Single-flight agent execution
The system SHALL execute at most one Agent SDK `query()` call at a time across all agents (synthesizer, coach, hints, pipeline).

#### Scenario: Overlapping submissions do not interleave
- **WHEN** two agent runs are submitted while another run is executing
- **THEN** the executing run completes before either submitted run starts, and the submitted runs execute one at a time

### Requirement: Priority ordering of pending work
The scheduler SHALL dequeue pending agent runs in priority order — coach before synthesizer/pipeline before hints — and FIFO within the same priority class.

#### Scenario: Coach jumps the queue
- **WHEN** a synthesizer pass is executing, a hint pass is pending, and a coach request is then submitted
- **THEN** the coach request executes immediately after the current synthesizer pass completes, before the pending hint pass

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

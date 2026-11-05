# agent-status-visibility

## ADDED Requirements

### Requirement: Lifecycle status events for every agent
The server SHALL emit an `agent.status` event with agent identity (`synthesizer`, `coach`, `hints`, `pipeline`) and state (`queued`, `running`, `done`, `failed`) at each lifecycle transition of an agent run.

#### Scenario: Queued vs running distinction
- **WHEN** an agent run is submitted while another run is executing
- **THEN** an `agent.status` event with state `queued` is emitted at submission, and a separate event with state `running` is emitted when execution actually begins

#### Scenario: Failure is broadcast
- **WHEN** an agent run times out, aborts, or errors
- **THEN** an `agent.status` event with state `failed` and a short human-readable detail is emitted to all connected clients

### Requirement: Status catch-up on connect
The SSE catch-up replay SHALL include the most recent status for each agent so a newly connected client renders current agent activity.

#### Scenario: Client connects mid-synthesis
- **WHEN** a client connects while a synthesizer pass is running
- **THEN** the catch-up replay includes an `agent.status` for the synthesizer with state `running`

### Requirement: UI reflects per-agent activity
The web client SHALL render agent activity indicators from `agent.status` events, including a visible distinction between waiting-in-queue and actively-running, and a visible signal when a run fails.

#### Scenario: Synthesizing chip driven by agent.status
- **WHEN** the synthesizer's status is `running`
- **THEN** the session controls show the synthesizing indicator, and it clears on `done` or `failed`

# mural-projection

## Purpose

One-way sync of canvas state onto the bound mural — revision diffing, batched widget create/update, id mapping persisted in the session snapshot, failure tolerance, and a view-only embed in the web UI — added strictly as a new reader that leaves existing canvas paths untouched.

## Requirements

### Requirement: Projector subscribes without touching existing paths
The MuralProjector SHALL consume `canvas.updated` events from the EventBus as a new independent subscriber. The `update_canvas` MCP tool, SynthesizerAgent, SessionMemory write path, SSE broadcast, and all existing canvas readers MUST remain unchanged in behavior.

#### Scenario: Projection is a pure addition
- **WHEN** a synthesis pass commits a canvas batch while a mural is bound
- **THEN** the SSE `canvas.updated` broadcast, hint pruning, and snapshot behavior are identical to before this change, and the projector additionally syncs the mural

### Requirement: Revision-diffed, batched sync
On each projection pass the projector SHALL diff canvas items against the last projected revision using `createdAtRev`/`updatedAtRev`, create all new stickies in a single batched API call, create areas individually, and apply updates as PATCHes. Projection passes SHALL be serialized with coalescing: if new revisions arrive mid-flight, one follow-up pass covers them. Retrying a pass MUST be idempotent (no duplicate widgets).

#### Scenario: Batch of new stickies
- **WHEN** a synthesis pass adds 15 new stickies
- **THEN** the projector issues one batched sticky-note create call for all 15, records their widget ids, and advances the last-projected revision

#### Scenario: Coalescing under load
- **WHEN** two canvas revisions land while a projection pass is in flight
- **THEN** exactly one follow-up pass runs and covers both revisions

### Requirement: Id mapping and slot state persist in the session snapshot
The projector SHALL persist its canvas-id-to-widget-id map, slot allocation cursors, bound mural id, and last projected revision inside the existing session snapshot. After server restart and hydrate, projection SHALL resume from the persisted state without creating duplicate widgets. Snapshots without projector state MUST hydrate normally with the projector idle.

#### Scenario: Restart without duplication
- **WHEN** the server restarts, hydrates a session with projector state, and a new synthesis pass commits
- **THEN** existing items are not re-created on the mural and only the new revision's changes are projected

#### Scenario: Old snapshot compatibility
- **WHEN** a snapshot from before this change is hydrated
- **THEN** the session loads normally and the projector stays idle until a mural is bound

### Requirement: Failure tolerance
Mural API failures (network errors, 4xx/5xx, rate limiting, expired auth beyond refresh) SHALL never block or corrupt session processing. The projector SHALL log the failure, mark itself degraded, leave the last-projected revision unadvanced for the failed range, and re-attempt on the next pass.

#### Scenario: Mural outage mid-session
- **WHEN** Mural API calls fail during a session
- **THEN** transcript ingest, synthesis, hints, coach, and the web UI continue normally, and once Mural recovers the projector catches up from the last successfully projected revision

### Requirement: View-only embed in the web UI
When a session is bound to a mural, the web UI SHALL display the mural's view-only embed in place of the React canvas, while retaining the transcript, hints, coach, agent status, and bounded-context detail cards. When no mural is bound, the web UI SHALL render the existing React canvas unchanged.

#### Scenario: Embed shown when bound
- **WHEN** the user opens the session view and a mural is bound
- **THEN** the embedded mural iframe is displayed where the canvas panel was, and hints/coach/transcript panels function as before

#### Scenario: Fallback without Mural
- **WHEN** no mural is bound
- **THEN** the session view renders today's React canvas with no behavioral difference

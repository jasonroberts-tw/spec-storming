# canvas-broadcast-coalescing

## ADDED Requirements

### Requirement: One broadcast per batch canvas mutation
When a batch canvas mutation (the `update_canvas` tool call) applies multiple items, the server SHALL apply all items, bump the canvas revision once, and emit exactly one `canvas.updated` event carrying the final canvas state.

#### Scenario: Batch of N stickies emits once
- **WHEN** an `update_canvas` tool call carries N stickies, bounded contexts, and hotspots
- **THEN** connected clients receive exactly one `canvas.updated` event after all N items are applied

#### Scenario: Single-item updates still broadcast
- **WHEN** a single canvas item is upserted outside a batch
- **THEN** a `canvas.updated` event is emitted for that change as before

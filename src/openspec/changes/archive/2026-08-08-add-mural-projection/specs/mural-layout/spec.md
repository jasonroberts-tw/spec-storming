# mural-layout

## ADDED Requirements

### Requirement: Bounded-context neighborhood layout
The layout engine SHALL place canvas items on a fixed grid as follows: one board area per bounded context titled with the BC name and styled by strategic classification (`core`/`supporting`/`generic`); member stickies inside their BC's area arranged in kind-rows in EventStorming reading order; stickies without a `boundedContextId` in a dedicated "Unplaced" area; and hotspots in a dedicated hotspot strip. Within a row, stickies SHALL be ordered by `order` when present, falling back to `createdAtRev`. Sticky fill colors SHALL follow the canvas kind color scheme, and low-confidence stickies SHALL be visually distinguished.

#### Scenario: Sticky with a bounded context
- **WHEN** a new sticky with kind `domainEvent` and a `boundedContextId` is projected
- **THEN** it is placed in the next free slot of the events row inside that bounded context's area, colored as a domain event

#### Scenario: Sticky without a bounded context
- **WHEN** a new sticky with no `boundedContextId` is projected
- **THEN** it is placed in the next free slot of the "Unplaced" area

#### Scenario: Hotspot rendering
- **WHEN** a top-level canvas hotspot or a sticky of kind `hotspot` is projected
- **THEN** it renders in the hotspot strip as a pink sticky rotated 45 degrees, and an item present both as a top-level hotspot and as a hotspot sticky with the same id renders only once

### Requirement: Write-once placement stability
The layout engine SHALL assign coordinates to an item exactly once, at creation, from its container's next free slot. Updates to an item's text, confidence, or style MUST NOT change its coordinates. The only layout-initiated move SHALL be a change of `boundedContextId`, which relocates the sticky to the next free slot of its new container. When a container's row is full, placement SHALL wrap to a new row and grow the area rather than repositioning existing items.

#### Scenario: Text update preserves position
- **WHEN** an already-projected sticky's text is refined by the synthesizer, after a human has manually moved that widget on the board
- **THEN** the projected update changes the widget's text without touching its coordinates, leaving the human's placement intact

#### Scenario: Bounded-context reassignment moves the sticky
- **WHEN** an already-projected sticky's `boundedContextId` changes
- **THEN** the widget is moved into the next free slot of the new bounded context's area

#### Scenario: Area growth without reflow
- **WHEN** a new sticky is placed in a container whose current row is full
- **THEN** the sticky is placed on a new row, the area is enlarged to fit, and no existing sticky's coordinates change

### Requirement: Explicit tidy reflow
The system SHALL provide an explicit, user-triggered "tidy board" action that performs a full layout recompute: re-sorting rows by `order`, compacting slot gaps, and repacking/resizing areas. Reflow MUST NOT occur outside this explicit action.

#### Scenario: User triggers tidy
- **WHEN** the user invokes the tidy action
- **THEN** all projected widgets are repositioned according to a fresh full-layout computation and the slot allocation state is rebuilt to match

#### Scenario: No implicit reflow
- **WHEN** any number of ordinary synthesis passes occur without the tidy action
- **THEN** no previously placed widget's coordinates are changed except by bounded-context reassignment

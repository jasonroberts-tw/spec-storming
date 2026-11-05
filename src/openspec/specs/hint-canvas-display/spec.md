# hint-canvas-display Specification

## Purpose
Render active coach hints on the canvas in a dedicated, visually distinct area, anchor them to the canvas elements they reference, and provide engage/dismiss affordances.

## Requirements

### Requirement: Active hints rendered on the canvas
The canvas UI SHALL display all `active` hints in a dedicated hints area, visually distinct from stickies, hotspots, and bounded contexts (lighter-weight treatment, with an indicator of the hint's kind). Hints with statuses other than `active` MUST NOT be rendered.

#### Scenario: Active hint appears on canvas
- **WHEN** a hints update arrives containing an `active` hint
- **THEN** the canvas renders the hint's text and kind in the hints area, styled distinctly from stickies and hotspots

#### Scenario: Retired hint disappears
- **WHEN** a hints update arrives in which a previously displayed hint is no longer `active`
- **THEN** the canvas removes that hint from display

### Requirement: Hint anchoring to canvas elements
When a hint references a canvas element via `targetId`, the UI SHALL visually associate the hint with that element (e.g. highlighting the target on hover or focus of the hint).

#### Scenario: Hovering an anchored hint highlights its target
- **WHEN** the user hovers or focuses a hint whose `targetId` matches a rendered canvas element
- **THEN** that element is visually highlighted while the hint is hovered or focused

#### Scenario: Anchored element absent
- **WHEN** a hint's `targetId` does not match any rendered canvas element
- **THEN** the hint still renders normally without a highlight association

### Requirement: Hint engagement and dismissal affordances
Each rendered hint SHALL offer two actions: engage (take the hint into the coach chat) and dismiss. Dismissing SHALL remove the hint without starting a conversation.

#### Scenario: Dismissing a hint
- **WHEN** the user activates a hint's dismiss action
- **THEN** the client requests dismissal, the hint's status becomes `dismissed`, and the hint disappears from all connected clients

#### Scenario: Engaging a hint from the canvas
- **WHEN** the user activates a hint's engage action
- **THEN** the client requests engagement and focus moves to the coach chat panel

### Requirement: New hints are noticeable
Newly arrived hints SHALL be visually distinguishable from hints that were already displayed (e.g. a brief freshness animation), consistent with how fresh canvas stickies are indicated.

#### Scenario: Fresh hint indication
- **WHEN** a hint is displayed for the first time on a client
- **THEN** it briefly receives a freshness treatment distinguishing it from previously displayed hints

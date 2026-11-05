# Refine, worked for one project: asdlc-dashboard

**Illustrative only.** This shows what the `refine` skill's steps produce for one project. Never
treat its platform, stack or runtime as a default for another. Anything marked *assumed* stands in
for the operator's real answer, to show the form.

## Use case

As a developer who tracks work in beads, I want an application I can run on my Mac that shows a
beads database as a work board, so that I can follow the state of the work without running bd
commands in the CLI.

Candidate non-goals, to confirm at Gate 1:

- Editing issues from the dashboard (it is a read-only view)
- Connecting to remote databases

## This is an epic

The original criteria describe several things a user would name separately, so the use case is an
epic. Proposed feature breakdown:

| Feature | Original criteria it covers |
|---|---|
| Board | Columns are hide-able. Mouse wheel works. I can zoom in/out. |
| Filter and search | Drop-downs filter by label, status, epic, feature. Drop-downs only include items that exist for cards not in a closed state. Done column can be filtered by last day, last week, last month. Free-text search over titles, descriptions, and notes in one text box. |
| Issue panel | Clicking a card opens an issue view on the right. Clicking away from an open issue view closes it. |
| Graph view | Issue view has a button to open a left-to-right graph of linked issues. Graph shows all upstream and downstream cards. Link types can be toggled, which may filter cards out. |
| Windows | Multiple windows can view different databases. Window position and size persist across open and close. |

## Questions for the operator, in one batch

Each comes straight from the original wording.

- **Board.** "Mouse wheel works": what scrolls, and in which direction? Does the wheel zoom when a
  modifier key is held?
- **Board.** "I can zoom in/out": with what input (keyboard shortcut, trackpad pinch, menu)? Does
  the zoom level persist?
- **Issue panel.** When the panel is open, does clicking a different card close the panel or switch
  it to that card?
- **Graph view.** Does "all upstream and downstream" mean transitively, to any depth? When a link
  type is toggled off, does a card stay visible if it's still reachable through another enabled
  link type?
- **Filter and search.** Do the filters combine with AND? Does free-text search apply on top of the
  drop-down filters?
- **Windows.** Is position and size remembered per database or per window?

## What users rarely state

- **Error states.** The database path is missing. The database is locked by a running bd process.
  The beads schema version isn't supported.
- **Empty states.** The database has no issues. The current filters match nothing.
- **Data freshness.** Does the board update when the database changes while it's open? How quickly?
- **Scale.** How many issues should the board handle comfortably?
- **Platform.** macOS only? Which versions?

## A refined criterion

**AC-IP-2**, from "clicking away from an open issue view closes it". *Assumed answer:* clicking
another card switches the panel.

- Given the issue panel is open, when the user clicks empty board space, the panel closes.
- Given the issue panel is open for issue A, when the user clicks card B, the panel shows issue B.

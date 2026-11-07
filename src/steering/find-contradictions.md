# Find Contradictions

Contradictions are gold in EventStorming: they mark exactly where the room lacks shared
understanding. Your job is to detect and surface them, never to silently pick a side.

## What to look for

- **Same concept, two definitions**: two speakers describing one event/term differently
  (e.g. "confirmed = authorized" vs "confirmed = captured").
- **Incompatible flows**: two process orderings that cannot both be true (reserve inventory
  on Order Placed vs after Payment Captured).
- **Temporal conflicts**: a later statement that reverses or undercuts an earlier one.
- **Ownership conflicts**: two contexts/teams both claiming (or both disclaiming) a
  responsibility.
- **Policy conflicts**: two "whenever X then Y" rules that would fire incompatibly.

## How to act

- Record a **hotspot** that names BOTH sides, who said what, and why they conflict — with the
  transcript line ids for each side.
- Keep it neutral and specific: "CONTESTED: when is inventory reserved? Sam (t-0017) says on
  Order Placed to prevent overselling; Lena (t-0019) says after capture to avoid holding
  abandoned stock."
- If a contradiction cannot be resolved without more data or a leadership decision, say so —
  that is a valid and important outcome.
- Never average two contradictory views into a fake consensus.

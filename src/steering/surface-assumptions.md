# Surface Assumptions

Assumptions are decisions nobody remembers making. Surfacing them early turns hidden risk
into an explicit, reviewable choice.

## What to look for

- **Stated-in-passing assumptions**: "we're assuming a single warehouse", "everyone's a
  registered customer" — capture these verbatim; they are future risks.
- **Implicit preconditions**: a flow that only works if something is true (payment always
  succeeds, stock is always accurate, one currency, one region).
- **"Of course" beliefs**: things treated as obvious that a new team member would question.
- **Scope edges**: what's being silently excluded (guest checkout, partial shipments,
  refunds, multi-item orders).

## How to act

- Record each assumption explicitly — on the relevant Bounded Context's **assumptions** list,
  or as a **hotspot** if it is risky or contested.
- State the assumption and its blast radius: "Assumes a single warehouse — multi-fulfillment
  would change the whole reservation model."
- Do not silently adopt an assumption into the model as if it were a decision; mark it as an
  assumption so it can be challenged.
- Cite the transcript line where it surfaced (or note that it was never stated, only implied).

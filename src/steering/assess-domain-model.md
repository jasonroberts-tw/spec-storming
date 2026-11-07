# Assess Domain Model

Evaluate the model as a connected explanation of business behavior, not as a count of
stickies. Ground every finding in visible canvas or transcript evidence and never invent
missing business decisions.

Apply the Domain Model Quality Reference that follows this method before scoring.

## Assessment workflow

1. Establish the modeled business outcome, actors, and current scope.
2. Trace each important behavior through actor → command → aggregate → event and, where the
   domain calls for reactions, event → policy → command. A pile of the right sticky types is
   not a coherent flow.
3. Check that actors have the read models needed to decide, aggregates protect named
   invariants, events have credible causes, and commands have observable outcomes.
4. Check that each bounded context has a cohesive purpose, internally consistent language,
   authoritative ownership, and named messages/counterparties at cross-context boundaries.
5. Challenge the happy path with rejection, cancellation, timeout, retry, recovery,
   compensation, duplicate, and terminal-state scenarios that could change the business result.
6. Evaluate evidence and uncertainty: important elements should trace to source material, while
   assumptions, contradictions, and unresolved decisions remain visible.
7. Separate:
   - a genuine gap in the model;
   - an unresolved business decision;
   - an assumption needing validation;
   - detail that can safely wait.
8. Prioritize advice by its effect on shared understanding and implementation risk.

## Coherence standard

A coherent model lets a domain expert navigate from a business goal to the decisions and
behavior that produce it. It has all of these properties for the declared scope:

- **Causal flow:** important commands have actors and decision inputs, target an owner of a
  rule or invariant, and lead to explicit business outcomes. Policies name both trigger and
  reaction.
- **Consistent meaning:** commands express intent, events are completed business facts, and
  terms have one clear meaning inside a bounded context.
- **Ownership and boundaries:** every important behavior has an authoritative context; context
  boundaries follow differences in language, policy, lifecycle, or ownership; cross-context
  messages identify the business contract and counterparty.
- **Decision integrity:** business rules, eligibility criteria, invariants, and the information
  used to decide are visible instead of implied by nouns or implementation components.
- **Lifecycle integrity:** happy paths connect to rejection, cancellation, recovery, timing,
  concurrency, and terminal outcomes wherever those can change business meaning.
- **Traceability and honesty:** important claims cite evidence; contradictions, assumptions,
  hotspots, and unknowns remain explicit until the group resolves them.

Do not award coherence merely because every sticky color is present. Disconnected elements,
unnamed ownership, contradictory terms, or missing failure behavior are coherence defects.

## Response contract

Return only one valid JSON object with this shape. Do not wrap it in Markdown fences.

```json
{
  "score": 6,
  "maturity": "Developing",
  "summary": "One sentence describing overall coherence and completeness.",
  "scoreRationale": "A concise explanation naming the strongest and weakest quality dimensions.",
  "feedback": [
    {
      "tone": "positive",
      "title": "Clear context boundaries",
      "summary": "One short sentence visible in the Coach panel.",
      "detail": "Specific evidence and why it matters."
    },
    {
      "tone": "constructive",
      "title": "Complete the cancellation path",
      "summary": "One short sentence visible in the Coach panel.",
      "detail": "Specific evidence, what is missing, and the next useful workshop question or action."
    }
  ]
}
```

Use an integer score from 0 to 10. Choose maturity from **Emerging**, **Developing**, or
**Coherent**. Return two to four feedback items, including at least one positive and at least
one constructive item about the highest-impact missing or weak area. Every constructive item
must end with a concrete workshop question or action. Keep the summary under 140 characters and
the complete response under 450 words.

Score completeness against the domain scope currently revealed:

- 0–2: isolated concepts; important behavior and ownership are mostly absent.
- 3–4: a recognizable flow exists, with major causal or ownership gaps.
- 5–6: core behavior and contexts are developing, but rules, language, or exceptions prevent
  the model from telling a complete story.
- 7: most main flows are connected, but at least one material coherence risk remains.
- 8: main flows, language, boundaries, rules, decisions, and exceptions are substantially
  coherent and traceable.
- 9–10: specification-ready for the declared scope; remaining uncertainty is explicit and
  low risk.

Apply these score caps:

- No end-to-end actor/decision → command → owner/invariant → event flow: maximum 4.
- Main flow exists but important ownership, rules, or failure outcomes are implicit: maximum 6.
- A contradiction or unresolved decision can change a core business outcome: maximum 7.
- Use **Coherent** only for scores 8–10; use **Developing** for 4–7 and **Emerging** for 0–3.

Weight the score using the quality dimensions in the reference. In `scoreRationale`, explain
why the weakest dimension constrains the score. When new context exposes an important missing
behavior, the score may decrease; explain that as newly visible scope, not model regression.

## Guardrails

- Cite named canvas elements, bounded contexts, hotspots, or transcript ids when available.
- Distinguish evidence from inference and label uncertainty.
- Do not prescribe technical architecture unless the domain evidence requires it.
- Do not silently resolve contradictions or manufacture business rules.
- Prefer a few consequential findings over an exhaustive checklist.
- Do not say only that a category is missing. Name the affected flow or context and provide the
  exact question the facilitator should ask next.

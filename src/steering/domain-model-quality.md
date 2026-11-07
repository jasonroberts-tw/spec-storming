# Domain Model Quality Reference

A good domain model creates shared, behavior-rich understanding of the business. It is not
made good by diagram size, implementation detail, or the number of named entities.

## Coherence tests

Use these tests before scoring. A model is coherent only when the answers form one compatible
business story for the declared scope.

1. **Outcome test:** Can the group name the business outcome and the lifecycle start and end?
2. **Causality test:** For every important event, is there a credible command, actor or policy,
   decision input, rule owner, and resulting state transition?
3. **Decision test:** Are the deciding role, required information, invariant or rule, possible
   answers, and consequences explicit?
4. **Language test:** Do terms and state transitions mean one thing within each context, with
   conflicts or synonyms made visible?
5. **Ownership test:** Does each behavior and fact have one authoritative bounded context, with
   explicit contracts where another context consumes it?
6. **Exception test:** Do rejection, cancellation, timeout, retry, recovery, compensation,
   duplicate, and terminal paths exist wherever they change a business outcome?
7. **Evidence test:** Can important model claims be traced to evidence, and are inference and
   uncertainty labeled rather than presented as agreement?

Failure of a core causality, decision, or ownership test is a coherence gap even when all
EventStorming sticky types are present.

## Quality dimensions

### Business purpose and scope

- The modeled outcome, users, and scope boundaries are explicit.
- Core-domain behavior reflects differentiating business capability.
- Supporting and generic concerns are not mistaken for the core domain.

### Behavioral completeness

- Important flows connect actors, commands, aggregates, domain events, policies, and read
  models.
- Commands express intent; events describe completed business facts in past tense.
- Events have credible causes, and commands have observable outcomes.
- Policies state the triggering event and resulting command.
- Happy paths, rejection paths, cancellation, recovery, and terminal states are represented.

### Ubiquitous language

- Terms have precise, business-owned definitions.
- Commands and events use language spoken by domain experts.
- Synonyms, vague verbs, and overloaded terms are exposed.
- The same word may differ across bounded contexts, but not silently within one context.

### Aggregates, rules, and invariants

- Aggregates protect meaningful business invariants and own state transitions.
- Business decisions and eligibility rules are explicit.
- Consistency boundaries are small enough to be credible and strong enough to protect rules.
- Money, inventory, identity, and other irreversible or scarce resources receive special
  scrutiny for duplication, ordering, and concurrency hazards.

### Bounded contexts

- Each context has a cohesive purpose, clear language, and identifiable ownership.
- A concept has one authoritative owner; other contexts consume contracts rather than share
  an ambiguous model.
- Inbound and outbound messages name both the business message and counterparty.
- Boundary choices follow changes in language, policy, lifecycle, or organizational ownership.

### Decisions and user needs

- Actors have the read models or information needed before issuing commands.
- Important business decisions name who decides, what information they use, and what outcomes
  follow.
- Manual work, exception handling, and external decision-makers are not hidden.

### Integrations and time

- External systems are identified at the boundary.
- Delays, deadlines, schedules, retries, duplicate messages, and out-of-order events are
  modeled where they change business outcomes.
- Cross-context consistency and compensation expectations are explicit business choices.

### Evidence and uncertainty

- Model elements trace to transcript or source evidence.
- Confidence reflects evidence quality.
- Assumptions, contradictions, hotspots, and open questions stay visible until resolved.
- The model does not present inferred behavior as agreed fact.

## Maturity guide

- **Emerging**: Useful nouns or events exist, but important behavior, ownership, or language is
  still disconnected or ambiguous.
- **Developing**: Major flows and contexts are visible; several rules, failure paths, or
  boundaries still need decisions.
- **Coherent**: Core flows, rules, language, ownership, exceptions, and boundaries form a
  traceable model suitable for specification, while remaining uncertainties are explicit.

## Completeness scoring

Use these dimensions to inform the 0–10 score:

- Behavioral flow coverage: 25%
- Business rules and invariants: 15%
- Ubiquitous-language clarity: 15%
- Bounded-context definition and ownership: 15%
- Failure and exception paths: 10%
- Actors and decision-support read models: 10%
- Evidence and explicit uncertainty: 10%

Treat the score as a current-scope coverage ratio, not a reward for adding more stickies.
Newly revealed requirements can legitimately reduce the score until the model incorporates
them. Explain meaningful score changes through newly exposed gaps rather than implying that
the model regressed.

### Dimension evidence

- **Behavioral flow coverage (25%)**: connected causal chains for primary outcomes, not just
  counts of actors, commands, aggregates, events, and policies.
- **Business rules and invariants (15%)**: named decisions and protected rules, including what
  happens when a rule rejects a command.
- **Ubiquitous-language clarity (15%)**: defined business terms and compatible state language
  within each context; explicit translation across contexts.
- **Bounded-context definition and ownership (15%)**: cohesive purpose, assigned behavior, one
  authority per fact, and named cross-context contracts and counterparties.
- **Failure and exception paths (10%)**: business-relevant rejection, cancellation, timing,
  retry, recovery, compensation, duplicate, and terminal outcomes.
- **Actors and decision-support read models (10%)**: who decides, what information they need,
  and what command or manual action follows.
- **Evidence and explicit uncertainty (10%)**: traceable source references plus visible
  assumptions, contradictions, hotspots, and unresolved decisions.

When giving missing-area guidance, start with the lowest-scoring dimension that could change a
core outcome. Cite the affected context or flow and turn the gap into one concrete workshop
question or modeling action.

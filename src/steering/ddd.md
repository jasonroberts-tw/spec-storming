# Steering: Domain-Driven Design

You apply Domain-Driven Design (DDD) to turn an EventStorming board into strategic structure.

## Bounded Contexts

A **Bounded Context** is an explicit boundary within which a domain model and its
**ubiquitous language** are consistent. The same word can mean different things in different
contexts ("Order" in Sales vs. Fulfillment) — that is normal and a signal of a boundary.

Cluster stickies into bounded contexts by **linguistic and responsibility cohesion**:
events/commands that share language and change together belong together. Strong signals of a
boundary: a shift in vocabulary, a different actor/team, a different rate of change, or an
integration seam (a message passed between clusters).

## Strategic classification

Classify each context's domain:
- **Core** — your competitive differentiator; invest your best effort here.
- **Supporting** — necessary but not differentiating; build pragmatically.
- **Generic** — a solved problem; buy/adopt off-the-shelf (e.g. payments, email).

## Context mapping

Capture how contexts integrate: which context **publishes** an event and which **subscribes**.
These published/subscribed messages are the inter-context contracts. Note the integration
style implicitly (event/notification vs. request/response) when the conversation reveals it.

## Bounded Context Canvas fields you populate

- **Purpose**: one line of strategic intent.
- **Strategic classification**: core / supporting / generic.
- **Ubiquitous language**: the precise terms + definitions used inside this context.
- **Inbound / outbound communication**: messages received from / sent to other contexts.
- **Business decisions**: key policies/rules the context owns.
- **Assumptions**: things taken for granted (single warehouse, registered customers).
- **Open questions**: unresolved issues scoped to this context.

## Discipline

- Keep ubiquitous language honest — do not invent terms the room didn't use.
- An assumption stated aloud ("we're assuming a single warehouse") is worth recording
  explicitly; assumptions are future risks.
- When two contexts seem to overlap or a sticky could belong to either, that ambiguity is a
  hotspot, not something to quietly decide.

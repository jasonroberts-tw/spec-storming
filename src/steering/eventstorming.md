# Steering: EventStorming

EventStorming is a collaborative modeling workshop that explores a business domain
through **domain events** — things that happened, always phrased in the **past tense**
("Order Placed", "Payment Captured"). You understand the grammar of an EventStorming
board and how the elements relate.

## The sticky vocabulary (and how they connect)

- **Domain Event** (orange): a fact that occurred, past tense. The backbone of the model.
- **Command** (blue): an intent/action that *causes* a domain event. Present imperative
  ("Place Order"). A command is issued by an actor and produces one or more events.
- **Actor** (yellow): a person or role that issues a command (Customer, Warehouse Operator).
- **Policy** (lilac): a reactive rule — "**whenever** <event> **then** <command/action>".
  Policies connect an event to a downstream command (the glue of process flow).
- **Read Model** (green): the information an actor looks at *before* issuing a command
  (Order Status, Pick List). Decision-support views.
- **External System** (pink): something outside the boundary you integrate with but don't
  own (payment gateway, carrier API, email provider).
- **Aggregate** (pivotal yellow): the consistency boundary / unit that commands act on and
  that emits events (Order, Shipment).
- **Hotspot** (red): a conflict, open question, risk, or disagreement that needs attention.
  Hotspots are gold — they mark where the room lacks shared understanding.

## The natural flow

`Actor → issues → Command → acts on → Aggregate → emits → Domain Event → triggers → Policy
→ issues → Command …` with Read Models informing actors and External Systems on the edges.

## How to read a transcript into a model

- Listen for **past-tense facts** → domain events. Convert "we take their money" into the
  event "Payment Captured", not a vague note.
- When someone says "whenever X we do Y" → that is a **policy** linking event X to command Y.
- Names people repeat are **ubiquitous language**; capture them precisely.
- Disagreements, "it depends", "we've never decided", two people describing the same thing
  differently → **hotspots**. Never silently resolve a disagreement; surface it.
- Prefer fewer, well-named stickies over many noisy ones. Reuse an existing sticky (same id)
  when the conversation refines a concept already on the board.

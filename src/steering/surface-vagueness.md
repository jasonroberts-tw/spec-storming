# Surface Vagueness

Imprecise language is where shared understanding silently breaks. Your job is to notice
it and make it explicit rather than smoothing it over.

## What to look for

- **Undefined nouns**: a term used as if shared but never defined ("the order", "confirmed",
  "the system"). Ask: would two people in the room draw this the same way?
- **Hand-wavy verbs**: "handle", "process", "deal with", "sync", "manage" — these hide the
  actual behavior. What concretely happens?
- **Quantifier mush**: "fast", "soon", "a lot", "sometimes", "usually" — no measurable
  meaning. What is the actual threshold or trigger?
- **Overloaded words**: the same word meaning different things in different contexts (a strong
  Bounded Context signal in DDD).
- **Passive ownership**: "it gets reserved", "they're notified" — by whom? what triggers it?

## How to act

- When vagueness is load-bearing (a decision or boundary depends on it), record it as a
  **hotspot** or an **open question** on the relevant Bounded Context — do not invent a
  definition.
- Prefer a precise restatement as a question: not "Order is vague" but "Does 'Order Confirmed'
  mean payment authorized or payment captured?"
- Cite the transcript line(s) where the vague term was used.

# Surface Constraints

Architecture is shaped by its constraints. Your job is to make the implicit constraints
explicit and turn them into testable non-functional requirements (NFRs).

## What to look for

- **Load & scale**: expected throughput, peak vs average, growth; what must scale
  horizontally; hot paths and bottlenecks.
- **Latency budgets**: user-facing response-time expectations; end-to-end budgets across a
  flow; which steps can be async.
- **Consistency & correctness**: where strong consistency is required (money, inventory) vs
  where eventual consistency is acceptable; idempotency needs; ordering guarantees.
- **Resiliency**: tolerable downtime, failure isolation, what must degrade gracefully, RPO/RTO
  for data.
- **Compliance & security**: regulatory constraints (PCI for payments, privacy), audit,
  data residency, retention.
- **Operational**: deployment cadence, observability requirements, cost ceilings, team/skills
  limits.

## How to act

- For each constraint, write a **specific, measurable NFR** ("p99 < 200ms at 500 rps",
  "no double-charge under retry", "process 10k orders/day with < 1h recovery"), not an
  adjective.
- Separate **system-wide** constraints from **per-bounded-context** ones (a core money context
  has stricter constraints than a generic notification context).
- Where a constraint is unknown but important, flag it as an explicit open question/assumption
  rather than silently choosing a value.
- Tie each constraint to its driver (business requirement, domain risk, scale expectation).

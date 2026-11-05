# Non-functional requirements

The `design` skill § 5 selects from this list. Where the team keeps its own NFR reference, its
definitions win over these.

## Baseline: always selected

Performance, Observability, Deployability, Evolvability.

## Security floor: always on

These hold whichever contextual NFRs are selected:

- Each new third-party dependency is a deliberate decision (`AGENTS.md` § Delivery workflow).
- CI MUST run secret scanning and dependency vulnerability checks.

## Contextual: selected when they apply

The ratio is the default split of effort between hosting or infrastructure, and code or frameworks.

| NFR | Infra / code | Working definition |
|---|---|---|
| Recoverability | 80/20 | Returning to a known-good state, including data, after a failure or loss |
| Scalability / Elasticity | 75/25 | Handling growth in load; elasticity adds and removes capacity as load changes |
| Durability | 75/25 | Data, once accepted, isn't lost |
| Cost efficiency | 60/40 | Meeting requirements at an acceptable running cost |
| Availability | 50/50 | The system is usable when its users need it |
| Security | 50/50 | Data and functions are protected from unauthorized access or change |
| Data consistency | 50/50 | Readers see data that meets the stated consistency guarantees |
| Resilience | 20/80 | Continuing to work, possibly degraded, while parts of the system fail |
| Reliability | 10/90 | Producing correct results consistently under expected conditions |
| Interoperability | 10/90 | Exchanging data and operations with other systems through shared contracts |
| Usability | 0/100 | The intended users can reach their goals easily |

## Using the ratio

The ratio says where an NFR's fitness function usually belongs. A mostly-infrastructure NFR is
usually verified by an infrastructure or configuration check, such as a restore drill. A
mostly-code NFR is usually verified by code-level tests.

The ratios assume a hosted workload. When there is no hosting tier, as with an app that runs only on
the user's own machine, the infrastructure share largely disappears. The NFR then either becomes a
code concern or does not apply.

# Test layers

The `design` skill § 6 plans tests at these layers. `AGENTS.md` § Delivery workflow says which are
protected.

| Layer | What it proves | When it's written or run |
|---|---|---|
| Unit | A single class or module behaves correctly | Written during Do, test-first (red, green, refactor), by the implementing agent |
| Functional | Entry point → work → result, with external dependencies stubbed | Written from the test plan, before the code it exercises |
| Integration | Entry point → work → side effects, against a real integration | Written from the test plan, before the code it exercises |
| Contract (optional) | A producer and consumer agree, when one exists or is being built alongside | Written from the test plan, before the code it exercises |
| End-to-end | One or two regression paths through the whole system work | Written from the test plan; the first path is built in the walking skeleton |
| Fitness function | An NFR target is met | Written from the spec's NFR selection |
| Mutation | The tests fail when the code they cover is changed | Run at Review on code changed in the feature |

Entry points include APIs, event handlers, CLIs and UI components. A UI component is tested at the
functional layer by driving it through its public interface, rendering it and sending user events,
with its dependencies stubbed.

Unit tests cover most individual class and module behaviour. Test the smallest meaningful unit of
behaviour first.

Mutation testing applies to unit and functional tests, and only to code changed in the feature. Its
score MUST reach `mutationMinScore` (`policy/delivery.json`). Unit tests are its priority, because
the implementing agent writes them and nobody reviews them before they are relied on.

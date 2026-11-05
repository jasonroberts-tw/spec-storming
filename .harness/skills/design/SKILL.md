---
name: design
description: Design one feature whose intent passed Gate 1 - decision records, runtime packaging, modules, contracts, NFR targets with their fitness functions, and the test plan, all in the feature's spec - and stop at Gate 2 for the operator's approval. Use when a feature's spec has its intent confirmed and no approved design, or the operator asks to design a feature or write its test plan.
---

Read AGENTS.md first. Everything below is subordinate to it.

# Design a feature

Entry: the feature's spec under `specDirectory` (`policy/delivery.json`) says `Intent confirmed`.
Without that, run the `refine` skill. This phase writes no implementation code. Work in a worktree
made by the one worktree script: `{{CLI_WORKTREE_CREATE}}`.

`example.md` beside this file shows a decision record and an NFR selection for one project. It is
illustrative: never infer a project's type, stack or runtime from it.

## 1. Decision records

Write one for each significant choice: the framework, the runtime packaging (step 2), storage, major
libraries, and any departure from existing conventions. Search `docs/decisions/` first, because an
earlier feature may have decided it already, such as the application's runtime; cite that record
instead of writing a second. Each new record goes under `docs/decisions/` in the format the
`should-i-adopt` skill § 8 gives, with status proposed. It states the context, the options
considered, the choice and its consequences.

## 2. Runtime packaging

- The build and the full test suite MUST be reproducible in a container and runnable in CI.
- A local container is the default runtime. Another runtime, such as a native local application,
  needs a decision record that says why.
- The runtime MUST be consistent with the acceptance criteria. If no runtime satisfies both the
  criteria and these rules, raise it at Gate 2.
- If part of the suite needs a specific host OS, such as native UI tests, the record says so, and CI
  runs that part on a matching runner.
- The design MAY offer a local server deployment or a hosted deployment.

## 3. Modules

First maximise cohesion: group together what changes for the same reason. Then minimise coupling:
reduce what each group needs to know about the others. Parts combine through a small set of
consistent interaction patterns, so a new combination needs no new agreement. Keep I/O and other
side effects at the edges, behind interfaces a test can replace, so each unit's behaviour can be
exercised without its real dependencies.

The spec lists each module with a one-sentence responsibility and the modules it depends on. Module
dependencies MUST NOT form a cycle. Where the stack has a tool that checks this, step 5 makes it a
fitness function.

## 4. Contracts

Define the contract of every entry point a protected test will exercise: an API, an event published
or consumed, or a UI that criteria depend on. Define the data models and schemas too. A contract is
settled here, before the code behind it, because the functional, integration and contract tests are
written against it.

## 5. NFRs

Read `nfrs.md` beside this file first. Then the spec records:

- for each contextual NFR, "applies" or "does not apply", with a one-line reason;
- for each selected NFR, which is the baseline plus every contextual NFR that applies:
  - a measurable target, such as "the list view renders 2,000 records in under 500 ms on the
    reference machine", where "fast" or "secure" is not a target;
  - the fitness function that checks the target;
  - when it runs: on every CI run, or on a schedule or manual trigger when it costs too much to run
    every time.

The spec names the reference machine that performance targets are measured on.

## 6. Test plan

Read `test-layers.md` beside this file first. For each planned test, state its layer, the criterion
or NFR it covers, the scenario, which dependencies are stubbed and which are real, and the path it
will live at. Name the test runner, and how to run one module's unit tests. Unit tests are not
planned here, because the `work` skill writes them test-first.

Every criterion is covered by at least one automated test at some layer. A criterion that cannot
reasonably be automated is marked **manual-verify**, with the steps the operator performs at Review.
UI behaviour SHOULD be covered by functional tests before it falls back to manual-verify. Each test
SHOULD name the ID of the criterion it covers in its name, tag or annotation, so coverage can be
checked mechanically.

## 7. One spec

Everything this phase produces goes into the feature's spec, after Refine's sections: `## Decisions`
(links to the records), `## Runtime`, `## Modules`, `## Contracts`, `## NFRs` and `## Test plan`.
MUST NOT create a separate design document beside it. The decision records under `docs/decisions/`
are the one exception, and the spec links each.

## 8. Gate 2: design approval

Show the operator the spec, and ask them to approve it. MUST NOT write implementation code for the
feature before that approval. Once they approve, set the `**Status:**` line to `Design approved
<date>`, mark each new decision record accepted, and open the pull request with the `open-pr` skill.
Its body quotes the approval. No story writes code until that pull request merges, because the
delivery hook reads the spec on `origin/main`. Any later change to the approved spec needs the operator's approval of
that change. Plan follows, with the `plan-stories` skill.

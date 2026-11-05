---
name: plan-stories
description: Slice a feature whose design passed Gate 2 into stories that each fit one session - a walking skeleton first in a new codebase, each story's criteria, protected tests, paths and dependencies, a traceability check - and file them in the tracker. Use when a feature's spec is approved and the feature has no stories, or the operator asks to plan, slice or break down a feature.
---

Read AGENTS.md first. Everything below is subordinate to it.

# Plan a feature's stories

Entry: the feature's spec under `specDirectory` (`policy/delivery.json`) says `Design approved`.
Without that, run the `design` skill.

## 1. Walking skeleton

In a new codebase, the first feature's story 0 is a walking skeleton. It holds a reproducible
container build, a CI pipeline that runs the test suite, the first end-to-end path through trivial
behaviour, and deployment when a deployment target is in scope. The skeleton wires the product's
suite into `mise run gates` with the `add-task` skill, so every later story's gates run it. Where
the stack has a tool that checks module dependencies, the skeleton adds it to the gates too, so a
cycle between modules fails the build. Every other story depends on the skeleton.

## 2. Slice the feature into stories

Each story MUST fit in one session, and MUST state:

- the criteria it satisfies, by ID, or a line `Enabler: <target>`, naming the design element or NFR
  it serves.
  Scaffolding, CI setup, contract definitions and the walking skeleton are typical enabler stories;
- the protected tests it must make pass, by their paths in the test plan;
- the modules or paths it expects to change;
- the stories it depends on;
- enough detail to implement it, citing spec sections where that helps.

## 3. Keep overlapping stories apart

Stories that expect to change the same module or path MUST NOT run in parallel, because one story's
merge rewrites what the other builds on. Give each such pair a dependency, so `bd ready` never offers
both at once. Stories with no such dependency can run in parallel.

## 4. Check traceability

Every criterion maps to at least one story, and to at least one test or manual-verify item. Every
story maps to a criterion or an enabler target. Fix each gap before filing anything. A gap that needs
the spec changed goes to the operator, as the `design` skill § 8 says.

## 5. File the stories

In one tracker bracket (`.beads/PRIME.md`), file each story as a `task` (`issueTypes` in
`policy/vocabulary.json`) under the feature with `--parent`. Its body holds step 2's fields, and each
dependency goes in `--deps`. Show the operator the plan as one table, with a row per story: its
criteria or enabler, protected tests, paths and dependencies. Then run
`node scripts/check-trace.mjs <feature id> --plan`, and fix each gap it reports. The operator MAY
review the plan before work starts.

Each story is then worked with the `work` skill, or several at once by the `fan-out-work` agent.

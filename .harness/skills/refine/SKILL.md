---
name: refine
description: Turn a request for new or changed product behaviour into a confirmed use case, non-goals, acceptance criteria and dependencies - split an epic into features, probe for requirements users rarely state, ask every ambiguity in one batch, and stop at Gate 1 for the operator's confirmation. Use when a request starts the feature track, or the operator asks to scope, refine or write acceptance criteria for a feature or an epic.
---

Read AGENTS.md first. Everything below is subordinate to it.

# Refine a request

This is the feature track's first phase (`AGENTS.md` § Delivery workflow). It ends at Gate 1 with
the intent half of each feature's spec, and writes no design and no code.

`example.md` beside this file shows what each step produces for one project. It is illustrative:
never infer a project's type, stack or runtime from it.

## 1. Orient

In an existing codebase, read what `AGENTS.md` § Delivery workflow names first. Search the specs
under `specDirectory` (`policy/delivery.json`) and the tracker (`bd search`) for the capability. A
spec that already covers part of it is named in the use case, because this work changes it.

## 2. Write the use case and its non-goals

The use case: "As a <actor>, I want <capability>, so that <goal>." The non-goals say what this work
will not do. They are the main control on scope, so write one for each thing a reader could expect
that the work leaves out.

## 3. Decide feature or epic

A feature is one use case: one primary actor and one goal. A request whose criteria describe several
things a user would name separately, such as "the list" and "the settings screen", is an epic.
Propose a breakdown into features, each with the request's wording it covers, and get the operator's
confirmation. Then run steps 4 to 8 once per feature.

## 4. Write the acceptance criteria

Each criterion is an observable outcome a test could check, written as Given/When/Then. Give each a
stable ID of the form `AC-<code>-<n>`, where the code of letters or digits names its feature, such
as `AC-IP-2`. An ID is never renumbered or reused, because stories and tests cite it, and
`scripts/check-trace.mjs` reads that form.

## 5. Probe for what users rarely state

Ask each of these of the feature, and record every answer as a criterion or a non-goal:

- error states: missing, unreadable, locked or incompatible inputs and data sources;
- empty states;
- data freshness: what happens when the underlying data changes while the software is in use;
- expected scale;
- target platforms and runtime expectations.

## 6. Name the dependencies

List the other systems, infrastructure and data sources the feature needs. Name anything it needs
that does not exist yet.

## 7. Ask every ambiguity in one batch

Each question quotes the wording it comes from. Ask them all at once, so the operator answers with
the whole picture. MUST NOT resolve a product ambiguity by assuming an answer: an assumed answer is a
product decision the operator never made. Gate 1 waits until every question has an answer.

## 8. Write the spec's intent

Make a worktree with the one worktree script: `{{CLI_WORKTREE_CREATE}}`. File the feature as a
`feature` (`issueTypes` in `policy/vocabulary.json`), under its epic with `--parent` when it has
one; an epic is filed first, as an `epic`. Write `<specDirectory>/<feature id>.md` with a
`**Status:**` line and four sections, which Design extends: `## Use case` (with the non-goals),
`## Acceptance criteria`, `## Dependencies` and `## Answers`, which holds each question of step 7
with the operator's answer. Link it with `bd update <feature id> --spec-id <path>`.

## 9. Gate 1: intent

Show the operator the use case, non-goals, criteria and dependencies, and ask them to confirm.
MUST NOT start Design without that confirmation. Once they confirm, set the `**Status:**` line to
`Intent confirmed <date>`, and open the pull request with the `open-pr` skill. Its body quotes the
operator's confirmation. Design follows, with the `design` skill.

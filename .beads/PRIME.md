# The task store in this repository

This is what `bd prime` prints here, at the start of every session and before every compaction, in
place of its own text. It states no rule. Each rule an agent follows here has the one home that
`AGENTS.md` § Rules for agents live in tracked files, and nowhere else names, and where this file
and `AGENTS.md` disagree, `AGENTS.md` wins.

Before a `bd` command, read where its rules live:

- `AGENTS.md` § Git workflow: commits, pushes and pull requests.
- `work` skill: an issue worked from its claim to its close.

A command's flags are in `bd <command> --help`.

Every task is an issue in `bd`, never a markdown checklist or an in-session todo list.
`bd ready` is the queue; do not add a status table to a document. Every run of tracker writes is
bracketed: pull before the first write and push after the last, and a rejected push is reported
with its exact command and error, never forced. Every open issue carries a label naming where its
work lands. An issue's type and priority are the first rows of `issueTypes` and `issuePriorities` in
`policy/vocabulary.json` that fit it: set when filed, and moved, with a note naming them, when
a session works or notes it. Otherwise `bd ready` ranks by who filed it, and when.

An issue a run files `discovered-from` the issue or epic it ran on also carries, from
`policy/vocabulary.json`, one `assetLabels` label for each kind of file it would change. Those
labels are what `bd count` reads across runs.

Before filing an issue other than a change's epic or its tasks, search for it: titles with
`bd search "<words>"` and descriptions with `bd list --all --desc-contains "<words>"`, closed issues
included, each again in other words, since one string can miss. A match gets a note, not a second
issue, and its count label (`seenLabelPrefix` in `policy/vocabulary.json`) goes up by one, or
nothing shows how often a cost recurs. A match closed as done whose defect is back is also filed
afresh, `related` to it, or the work never reaches `bd ready`.

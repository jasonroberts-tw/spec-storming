---
name: fan-out-work
description: Dispatch the ready issues of the task store to parallel lanes, one fresh agent per lane in its own worktree, and integrate what they produce. Use when asked to sweep, fan out or parallelise ready work, as the session itself
---

# Fan out ready work

You are the dispatcher, in the session the user started: one launched as a named agent got none of
its lanes' reports. You do not implement.

## 1. Pre-flight the trunk

On a fresh branch cut from `origin/main`, run `mise run gates`. A sweep
launched from a red trunk hands every lane an inherited failure that reads as its own. If the trunk
is red, stop and report the failing gate.

## 2. Partition the ready work into lanes

Read the queue (`bd ready`) and, for every pair of issues, decide the overlap by reading the
files each will touch, not the titles:

| Overlap kind | What it looks like | What to do |
|---|---|---|
| Same lines | two issues rewrite the same function, table or paragraph | one lane takes both, in order |
| Same file, separate blocks | two issues each add a block to one file | sibling lanes; give each a named anchor (the heading or the entry it adds after) so the merges do not collide |
| Same generated file | two issues each change an input of one emitter | accept it: separate lanes, and regenerate that file after each merge |

An issue whose premise you cannot verify from the checkout is not dispatched; note why on the issue.
Dispatch at most `fanOutMaxLanes` lanes (`policy/agent-workflows.json`), because each lane is a
session that spends on its own; the rest wait for the next sweep.

Write the partition down before you claim anything: one row per lane, with its issues, the files
each touches, the overlap kind and the anchor. Claiming is the first step another session or a
watching user would want to catch.

## 3. Pre-claim every issue in one tracker bracket

One bracket, so no second session picks up an issue between two of your claims.

## 4. One fresh agent per lane, each in its own worktree

Launch each lane with the Agent tool's `isolation: "worktree"`, whose hook runs the one worktree
script: a lane told instead to enter a worktree by path can run and write nothing there
(not verified against the CLI). Brief each lane with: its issues, its anchors, the skill it follows
(`work`), where it stops in it, that it makes no worktree at § 3, that its
anchors narrow nothing § 4 asks, and these two rules, stated in every brief word for word:

1. **Never end a turn while a command runs.** A turn end kills the lane's background run or leaves
   it running unwatched.
2. **An acceptance criterion that acts outside the repository becomes a follow-up issue labelled
   `human` at creation and is never performed by the lane.**

A lane stops at the end of the `work` skill § 5 and writes its branch and both gate
runs as measured, or why it stopped sooner, to `.scratch/lane-report.md` in its worktree. It opens
no pull request and closes no issue. Read that file at the `worktreePath` its completion notice
gives: its final message may not arrive (not verified against the CLI).

## 5. Integrate on your own branch

As each lane reports green, cherry-pick its commits onto your branch. Resolve any conflict there,
not in a merge commit: GitHub's rebase merge cannot carry
one. Never rebase a branch that has been pushed. After
each lane, regenerate every generated file more than one lane touched, re-derive each figure a lane
measured without the others' work, then run
`mise run gates`.

## 6. Open the pull request and watch its checks

Before it opens, the `work` skill § 6 reviews your branch once for each issue the lanes carried.
Once `open-pr` reports the merge, close each issue the lanes carried as the
`work` skill says.

## 7. Report one table

| Lane | Issues | Branch | Gates (as measured) | Merged | Follow-ups filed |
|---|---|---|---|---|---|

Then: issues not dispatched and lanes kept, each with why.

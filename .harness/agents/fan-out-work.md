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

Write the partition to `.scratch/sweep.md` before you claim anything: one row per lane, with its
issues, the files each touches, the overlap kind and the anchor. Claiming is the first step another
session or a watching user would want to catch.

That file locks the sweep: its issues are the sweep's whole work. An issue filed after it is
written, by you, a lane or a reviewer, at any priority, joins no lane and no round of fixes. It
waits in the queue, because a sweep that takes on what it finds has no end. When such an issue
blocks a locked one, the locked issue stops and is reported as blocked. After a restart or a
compaction, read the file again, not the queue.

## 3. Pre-claim every issue in one tracker bracket

One bracket, so no second session picks up an issue between two of your claims.

## 4. One fresh agent per lane, each in its own worktree

{{CLI_LANE_LAUNCH}} Brief each lane with: its issues, its anchors, the skill it follows
(`work`), where it stops in it, that it makes no worktree at § 3 and its first command is
`node scripts/setup-worktree.mjs <issue id>-<slug>`, which you name for its first issue, that its
anchors narrow nothing § 4 asks, and these two rules, stated in every brief word for word:

1. **Never end a turn while a command runs.** A turn end kills the lane's background run or leaves
   it running unwatched.
2. **An acceptance criterion that acts outside the repository becomes a follow-up issue labelled
   `human` at creation and is never performed by the lane.**

A lane stops at the end of the `work` skill § 5 and writes its branch and both gate
runs as measured, or why it stopped sooner, to `.scratch/lane-report.md` in its worktree. It opens
no pull request and closes no issue. Read that file at the `worktreePath` its completion notice
gives: its final message may not arrive (not verified against the CLI). Take the branch from that
file, never from the notice, which names the branch the worktree had before its setup renamed it.

## 5. Integrate on your own branch

As each lane reports green, cherry-pick its commits onto your branch. Resolve any conflict there,
not in a merge commit: GitHub's rebase merge cannot carry
one. Never rebase a branch that has been pushed. After
each lane, regenerate every generated file more than one lane touched, re-derive each figure a lane
measured without the others' work, then run
`mise run gates`.

## 6. Open the pull request and watch its checks

Before it opens, the `work` skill § 6 reviews your branch once for each issue the lanes carried,
and each issue's reviews count against `reviewMaxRounds` on their own. A lane fixes only the gaps
§ 6 has it fix. An issue that reaches the bound with a blocking gap open goes to the operator, who
decides whether the pull request carries it.
Once `open-pr` reports the merge, close each issue the lanes carried as the
`work` skill says.

## 7. Report one table

| Lane | Issues | Branch | Gates (as measured) | Merged | Follow-ups filed |
|---|---|---|---|---|---|

Then: issues not dispatched and lanes kept, each with why, and every issue filed during the sweep.

The sweep ends with this report. Start no second sweep unless the operator asks for one, because a
sweep's own findings refill the queue it was sent to empty.

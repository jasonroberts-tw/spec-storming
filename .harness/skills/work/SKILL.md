---
name: work
description: Work one or more issues from the task store end to end - verify the premise, claim, implement on the issue's track (a story test-first against its protected tests, a defect from a failing test, a small change from a green suite), review in a fresh context and validate. Use when asked to work, pick up or finish an issue. Specify 'via-pr' to automatically create a PR when work is complete; specify 'via-merge' to automatically merge to local main when work is complete
---

# Work an issue with beads

The argument is one issue id, several, or nothing (then take the top of
`bd ready`. Work agreed in conversation that no issue
carries yet is filed before it is worked, in step 3. 

## 1. Verify the premise before any work

An issue's title is not evidence, and nor is a "blocked on" line in its prose: `bd show` lists the
dependencies the tracker records. Read the issue, then read the code it talks about, and decide
which of four things is true, citing file and line for each claim:

- **still valid**: the defect or the gap is there, as described;
- **already fixed**: name the commit or the pull request that fixed it;
- **obsolete**: what it asks for no longer applies, and why;
- **blocked**: the work needs something that is in neither the repository nor the issue's own
  scope; name it, and the open issue that carries it, if one does.

Read that code as the trunk has it: this step runs in the primary checkout, whose `main` trails
`origin/main` until someone pulls it. Run `git fetch origin main`, then read with
`git show origin/main:<path>`. Where a fetch is not wanted yet, `gh api "repos/{owner}/{repo}/contents/<path>?ref=main" -H "Accept: application/vnd.github.raw"`
reads the same file without one. An agent sent to read the code reads the checkout's copy unless its
brief says otherwise (not verified against the CLI), so say so.

Name, too, any recision record an acceptance criterion implies or that names the issue 
and each criterion this session cannot meet from where it runs.

What happens next depends on who is listening:

- **With a live user:** when the premise does not hold, show the evidence and stop. The user decides
  whether the issue closes, changes or stands. When it changes, record that in the issue before any
  work: rewrite its title and description, with a dated section naming what was dropped and why so
  it is never re-filed, and file any part split out as its own issue. The same holds when the user
  changes the scope once work has begun: record it before the work it adds, and rewrite any
  follow-up already filed from the issue to match, so neither still describes the old scope.
- **In an autonomous session:** write the evidence into the issue as a note, leave the issue open,
  and move to the next one. Never close an issue on your own reading of its premise.
- **Blocked:** with a live user, taking on the prerequisite is the user's call on scope. In an
  autonomous session, take it on only when no open issue carries it and the acceptance criteria
  cannot be met without it: write its smallest form. Otherwise it is a premise that does not hold,
  handled as above.

## 2. Partition before claiming

With several issues, use the `fan-out-work` sub-agent

## 3. Claim, then work in a worktree

Claim the issue in the tracker (`bd update <id> --claim`); with several, claim every one step 2
kept, in one bracket, before the first worktree. Make the worktree with the one worktree script,
never natively: `{{CLI_WORKTREE_CREATE}}`. Read `.worktree/CONTEXT.md` there. Tracker writes that carry a
body, such as step 1's re-scoping, are made from here. Work agreed in conversation has no issue to
claim yet, so the order turns round: make the worktree, search for an issue that already carries the
work, then file it from here and claim it. Step 1
still applies, with what was agreed standing for the issue: each part of it is a premise, and a part
that does not hold goes back to the user with its evidence before anything is filed, even a part the
session proposed itself.

## 4. Implement on the issue's track, regenerate, gate

The issue's type names its track (`AGENTS.md` § Delivery workflow): a `task` under a feature is a
story, a `bug` is a defect, a `chore` is a small change, and a `task` with no feature is a harness
task.

- **Story.** The feature's spec on `origin/main` says `Design approved`; without that, stop. In an
  existing codebase, `mise run gates` is green before the feature's first story; if it is not,
  report and wait. When the story's protected tests do not exist yet, write them from the spec's test
  plan, list each in `protectedTestsFile` (`policy/delivery.json`) as `<path> <issue id>`, and commit
  both before any implementation code: the tests are protected from that commit on. Then implement
  test-first with unit tests: red, green, refactor, running the module's unit tests after each green
  step. Make the protected tests pass without changing them.
- **Defect.** Reproduce it with a failing test at the lowest layer that shows it; where its cause is
  not yet known, the `root-cause` skill finds it first. List that test in `protectedTestsFile` and
  commit both before the fix. Then fix the code until the test passes. A fix that needs a contract, a criterion or the
  spec changed stops here. With the operator's confirmation, it becomes feature-track work that
  enters at the `refine` or `design` skill.
- **Small change.** `mise run gates` is green before anything changes; if it is not, stop and report.
  Then make the change.
- **Harness task.** A `task` with no feature above it, and no `asset:product` label, is worked as
  written: its acceptance criteria stand in for a spec. A `task` with no feature that carries
  `asset:product` is product work that skipped the feature track. Stop and ask the operator, or, in
  an autonomous session, say so in a note and leave it open.

Stage every file the change adds (`git add`) before the gates run: a new file not yet added passes
the citations gate unread. Run `mise run gates`, the build check here.  
Run no task name `tasks.toml` does not list. 
A red gate is fixed or reported, never bypassed; where its cause is not yet known, the
`root-cause` skill finds it first.

Work found on the way that lies outside the issue's scope is filed as its own issue, never folded
in, because a grown issue no longer matches what was planned and reviewed. File it before the pull
request opens, so the pull request's body names the new id. File it with `foundIssueCommand` in
`policy/vocabulary.json`. When it blocks this issue, record that dependency and stop.

Stop, write the current state into a note on the issue, and report to the operator when:

- a contract or a protected test looks wrong;
- a criterion turns out ambiguous, or contradicts another;
- one failure has outlasted `rootCauseMaxFixes` failed fixes (the `root-cause` skill § 6);
- the work needs a module or path that another in-progress story declared;
- the approved spec would need to change.

## 5. Rebase and gate again

As `AGENTS.md` § The gate ladder says.

## 6. Review in a fresh context

Hand the `spec-reviewer` agent the scope (story, defect, small change or harness task), the issue
id, the feature's spec path when there is one, the diff range `origin/main...HEAD` and step 5's gate output.
Withhold this session's transcript, because a reviewer who reads the implementer's reasoning
inherits its blind spots. Fix each gap it reports that lies in the issue's scope, and review again.
Any other gap goes to the operator, who decides it. MUST NOT decide on your own that a gap is
acceptable. In an autonomous session, such a gap goes into a note on the issue, and the issue stays
open.

## 7. Integrating with main

If `via-pr` use `open-pr` skill and wait for it to finish
If `via-merge` merge to local main. Don't push to remote main
If neither ask the operator what they want

## 8. Close with a reason

Once integration is complete (PR merged or local main merged), close the issue with a reason that names the pull request or commit SHA, passed with `bd close <id> --reason-file <file>`. 
A story's reason also says what was done, and what, if anything, was deferred. When it was its
feature's last open story, the `review-feature` skill runs next.

If you stopped for any other reason (e.g. failure, blocked) the issue stays open, with a note
naming the commit(s), pull request if one was created, and any issue it waits on.

## 9. Report

Keep it short. It says what step 1 verified and where, what changed and what was
regenerated. It ends with the issue's final state and every follow-up filed.

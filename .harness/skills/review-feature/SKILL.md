---
name: review-feature
description: Review a feature whose stories are all closed - hand it to the fresh-context spec-reviewer agent, give the operator its gaps and manual-verify list, then reconcile the spec with what shipped and close the feature. Use when a feature's last story closes, or the operator asks to review, accept or close a feature.
---

Read AGENTS.md first. Everything below is subordinate to it.

# Review and close a feature

Entry: every story under the feature is closed (`bd children <feature id>`). Each story reached
`main` through its own pull request, so this review is the operator's acceptance of the whole
feature.

## 1. Hand it to a fresh reviewer

On a fresh branch cut from `origin/main`, run `mise run gates` and keep its output. Hand the `spec-reviewer` agent the scope
`feature`, the feature's id, its spec path, the stories' pull requests (each story's close reason
names its own) and that output. Withhold this session's transcript, because a reviewer who reads the
implementer's reasoning inherits its blind spots.

## 2. The operator decides each gap

Give the operator the report: each gap with the phase it points back to (Refine, Design, Plan or Do),
and the manual-verify list. The operator performs the manual-verify items and decides, for each gap,
whether to re-enter that phase. MUST NOT decide on your own that a gap is acceptable. A gap
re-entered at Do becomes a new story under the feature, with the fields `plan-stories` § 2 lists. One
re-entered at Refine or Design runs that skill, and the operator approves the spec's change.

The phase exits once the operator accepts the feature with no open gaps. In an autonomous session the
report goes into a note on the feature, and the feature stays open.

## 3. Confirm the deployment

When deployment is set up, confirm that it succeeded with the feature's last story in it. A failed
deployment is handled like a failed CI run: reopen the story it points at, or file a new one. MUST
NOT bypass or disable a failing check.

## 4. Reconcile the spec

Edit the spec so it describes the shipped behaviour, including each change the operator approved
along the way. Set its `**Status:**` line to `Shipped <date>`, and open the pull request with the
`open-pr` skill.

## 5. Close the feature

Once that pull request merges, close the feature with a reason that names it, through
`bd close <id> --reason-file <file>`. When it was its epic's last open feature, close the epic too.

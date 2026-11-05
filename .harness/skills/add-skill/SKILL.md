---
name: add-skill
description: Admit an outside skill to policy/skill-sources.json installedSkills, move an admitted skill's pin, or remove one - fetch it at a full commit, run the guard scan, the skill-assessor agent and the skills.sh audit, then open the pull request or file the findings for the operator to accept, reject or reconcile. Also the checklist of files to edit when a tracked skill under .harness/skills/ comes or goes. Use when asked to add, install, adopt, update, re-pin or remove a skill from the skills CLI or skills.sh, or when a sync reports a skill held by its audit.
argument-hint: "<owner>/<repo> <skill> [ref] | <skill> --move <ref> | <skill> --remove"
---

Read AGENTS.md first. Everything below is subordinate to it.

An installed skill is another repository's text, loaded word for word into every session on every
machine, and nobody here can edit it. That breaks `AGENTS.md` § Rules for agents live in tracked
files, and nowhere else, so this skill's checks stand in for the rule. A row lands only through
them, and only a person's merge lands it, since a changed row installs another repository's text
on every machine. Work from the primary checkout; write scratch files under `.scratch/add-skill/`.

## 1. Look for a prior decision

Search `docs/decisions/` and the tracker's closed issues (`bd list --status closed --json`) for the
skill's name. A skill once rejected is not re-proposed without evidence the decision did not weigh:
a newer commit that changes what it found. With none, report the decision and stop.

## 2. Fetch it at a full commit

Resolve the ref (the default branch when none is given) with `git ls-remote
https://github.com/<owner>/<repo> <ref>` to a 40-character SHA. Clone into
`.scratch/add-skill/<skill>-src` and check out that SHA; find the directory whose `SKILL.md` names
the skill. Nothing lands in `.claude/skills/` here: `mise run skills:install` installs it, through
`node_modules/.bin/skills`, the dev dependency `package.json` pins.

## 3. Run the three checks

1. **The guard scan**: `node scripts/skill-sources.mjs scan <the skill's directory>`. Each
   `finding:` line is a command in a code block that a guard here refuses.
2. **The assessment**: hand the `skill-assessor` agent the skill's directory and the SHA, and for a
   pin move the diff from the row's old commit: `git -C <clone> diff <old> <new> -- <skill path>`.
3. **The audit**: `node scripts/skill-sources.mjs audit <owner>/<repo> <skill>`. Each provider
   result other than `pass` is a finding, and so is no audit at all.

## 4. No finding: open the pull request

Add the row to `policy/skill-sources.json` `installedSkills` as `installedSkillsMeans` gives it:
the source, the SHA as `commit`, the reason this repository wants it, the assessment (`commit`, the
SHA of `origin/main` as `rulesCommit`, `findings: 0`) and the audit result as read. Run `mise run
skills:check`, then the `open-pr` skill. The description carries all three results in full. The
first admission in this repository also adds its decision record under `docs/decisions/`.

## 5. A finding: file it and stop

File a `decision` issue (`issueTypes` in `policy/vocabulary.json`), labelled `asset:prompt`, with
every finding and these three options, then stop. The operator chooses:

- **accept**: a session adds the row as in § 4, with the findings count, the issue's id as
  `assessment.issue`, and the audit result the operator accepted;
- **reject**: the issue closes with its reason, which § 1 finds next time;
- **reconcile**: the `should-i-adopt` skill reviews the skill and writes its decision record, which a
  note on the issue names: vendoring an adapted copy under `.harness/skills/`, or changing a rule
  here, among its options.

## 6. A held skill

A sync holds a skill when a provider's audit worsens to `fail`, HIGH or CRITICAL. The audit names no
commit, so read the flag against the pinned SHA, then take § 5 with the new result.

## 7. Removing one

A pull request deletes the row; each machine's next sync removes the skill. Add nothing else.

## A tracked skill comes or goes

Edit, in the same change: its row in `policy/prompt-budgets.json`; its row in
`.harness/skills/README.md`; tests whose subject it is; and every file `git grep -n <name>` finds.
A tracked skill copied by hand from an outside one records its source and commit, or moves to
`installedSkills` through this skill.

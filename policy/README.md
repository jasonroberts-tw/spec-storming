# `policy/`

**The workflow's policy: every constant a prompt or a tool reads, each under a key with its reason
beside it, in one record per kind of key.** Every record is a hand-authored decision record
(`AGENTS.md` § Three kinds of file, and never a fourth): it opens with `describes`,
`whyThisFileExists`, `gatedBy`, `whatItDoesNOTDo` and `provenance`, and gives each constant a
`<key>Means` sibling.

A reader asks for a key, never for a record: `tools/lib/policy.ts` merges every record into one
object and refuses a key two records define, and `node tools/lib/policy.ts <key>...` prints keys for
a prompt or a script. `check:policy` refuses a record without its header, a constant without its
`Means`, a key in two records, and a record this table does not name. What each value must be is
held by the gates its record's `gatedBy` names.

Each record's header is the authority on it. Where a row here and a record disagree, the record wins
and the row is corrected.

| Record | What it holds |
|---|---|
| `agent-workflows.json` | The bounds on how a session works: how many fixes that each failed it makes against one failure before it stops and reports (`rootCauseMaxFixes`, which the `root-cause` and `open-pr` skills read), and how many lanes one sweep dispatches (`fanOutMaxLanes`, which the `fan-out-work` agent reads). |
| `delivery.json` | The bindings of the delivery workflow: where a feature's spec lives (`specDirectory`), and the least mutation score Review accepts on changed code (`mutationMinScore`). |
| `prompt-budgets.json` | `promptWordBudgets`, one table keyed by each prompt's path, each row the most words the prompt may hold and the reason for the figure. |
| `skill-sources.json` | Which outside skills every machine gets: the Claude Code plugins enabled (`claudeEnabledPlugins`) and their pinned marketplaces (`claudePluginMarketplaces`), the skills the `skills` CLI installs at a pinned commit with the assessment and audit each passed (`installedSkills`), and the bounds on admission and sync (`skillAssessorMaxFindings`, `skillAuditTimeoutSeconds`). |
| `tool-settings.json` | The settings of single tools: how much of a failing job's output the git hook runner prints (`gitHooksFailedOutputBytes`), the project's GitHub repository and the account that owns it (`githubRepository`, `githubRepositoryOwner`), and the agents' optional GitHub App, its installation, when a kept token is replaced, and the bot account the dev container commits as (`githubApp*`). |
| `vocabulary.json` | The spellings the tracker's issues are filed with: the label for each kind of file a found issue would change (`assetLabels`), the command that files one (`foundIssueCommand`), the type and priority every issue takes (`issueTypes`, `issuePriorities`), and the prefix of the label that counts how many runs have found an issue (`seenLabelPrefix`). |

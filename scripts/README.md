# `scripts/`

**The programs `tasks.toml`, the git hooks and the dev container run: the gates, the hook runner,
and the steps that set a machine up and keep it matched to the repository.** Each opens with the
header `AGENTS.md` § Standing rules for prompts and gates gives it, and that header is the authority
on it: where a row here and a header disagree, the header wins and the row is corrected.

| File | What it is, or for a gate, what it refuses |
|---|---|
| `bootstrap.mjs` | Sets a machine up to work here, every step a program can run, in order, ending with the doctor (`mise run bootstrap`). |
| `check-beads.mjs` | The tracker gate: an open issue filed `discovered-from` another with no asset label, an issue type the rubric does not name, and an identifier that does not resolve here. |
| `check-deps.mjs` | The dependency gate: a package version with a known vulnerability on osv.dev in any tracked lockfile or manifest osv-scanner reads. |
| `check-policy.mjs` | The policy gate: a record under `policy/` without its header, a constant without its `Means`, and a key two records define. |
| `check-secrets.mjs` | The secrets gate: a secret Betterleaks finds in a commit, the unpushed ones at pre-push and every one reachable from HEAD in CI. |
| `check-protected-tests.mjs` | The protected-tests gate: refuses a mistyped list line, a listed test HEAD does not hold, and a test `origin/main` protects that the branch changed; reports each lifted line and each test the branch listed. |
| `check-trace.mjs` | One feature's traceability: a criterion no story, test plan entry or tracked test names, and a story that cites no criterion and names no enabler. |
| `doctor.mjs` | Probes this machine's setup and changes nothing, one line per probe, each warn and fail naming its fix. |
| `git-hooks.mjs` | The git hook runner: runs each event's jobs from `git-hooks.yml`, installs the hooks, and runs `mise run gates`. It also installs the ref hook that makes Git refuse a write to `main` or `release` from a linked worktree, and refuses a push to either from one. |
| `github-app-token.mjs` | Mints the agents' GitHub App token for `git` and `gh` in the dev container, and hands it out. |
| `hooks/` | The in-session hooks: the guards the CLI runs, and their selftest. |
| `new-worktree.sh` | Makes one worktree per agent task for a CLI with no worktree tool: a branch off `origin/main`, added locked, then set up by `setup-worktree.mjs`. |
| `render-integrations.mjs` | Renders the selected CLI integrations from `.harness/`, or compares them without writing. |
| `render-worktree-context.mjs` | Allocates a worktree's ports and renders its briefing, `.worktree/CONTEXT.md`. |
| `setup-worktree.mjs` | Sets up the worktree it runs in, as a session's first command there: names the branch `agent/<name>`, sets the App's bot account as the commit identity, copies the installed skills, renders the briefing and runs `npm ci`. |
| `skill-sources.mjs` | Holds `policy/skill-sources.json` to its rules, and makes a machine's plugins and installed skills match it. |

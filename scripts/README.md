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
| `check-product.mjs` | The product gate, over `src/`: no pnpm or no uv on the PATH, a pnpm other than the version `packageManager` names, no `src/node_modules`, a lockfile that fails a frozen install, a package with test files and no `test` script, a failing typecheck, test, build or Python test, and a test run that reports 0 tests. |
| `check-secrets.mjs` | The secrets gate: a secret Betterleaks finds in a commit, the unpushed ones at pre-push and every one reachable from HEAD in CI. |
| `check-tool-pins.mjs` | The tool-pin advisory gate: a tool version `mise.toml`, `mise.lock` or a tracked `packageManager` pins that has a known advisory on osv.dev, a mise pin with no row in `toolPinOsvPackages`, a `packageManager` with no row in `packageManagerOsvPackages`, a row that names no pin, and a Go package whose `/vN` does not match the pin's major version; it names each pin whose row says `unchecked`. |
| `check-trace.mjs` | One feature's traceability: a criterion no story, test plan entry or tracked test names, and a story that cites no criterion and names no enabler. |
| `doctor.mjs` | Probes this machine's setup and changes nothing, one line per probe, each warn and fail naming its fix. |
| `gh` | `gh` as the agents' GitHub App for a session on the host: it runs the first other `gh` on PATH with the token `github-app-token.mjs` mints, and runs none when no token is minted, or when the first other `gh` on PATH is another clone's wrapper. It adds nothing to gh's environment but `GH_TOKEN`, and drops `CDPATH`. |
| `git-hooks.mjs` | The git hook runner: runs each event's jobs from `git-hooks.yml`, installs the hooks, and runs `mise run gates`. |
| `github-app-token.mjs` | Mints the agents' GitHub App token for `git` and `gh` in the dev container, and for `gh` on the host through the wrapper `gh` in this directory, and hands it out. |
| `hooks/` | The in-session hooks: the guards and worktree hooks the CLI runs, and their selftests. |
| `new-worktree.sh` | Creates one worktree per agent task: a branch off `origin/main`, its ports and its briefing. |
| `render-integrations.mjs` | Renders the selected CLI integrations from `.harness/`, or compares them without writing. |
| `render-worktree-context.mjs` | Allocates a worktree's ports and renders its briefing, `.worktree/CONTEXT.md`. |
| `skill-sources.mjs` | Holds `policy/skill-sources.json` to its rules, and makes a machine's plugins and installed skills match it. |

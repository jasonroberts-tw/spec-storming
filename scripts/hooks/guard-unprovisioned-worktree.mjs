/**
 * PreToolUse hook on Bash. Refuses every command in a linked worktree whose branch is not
 * `agent/<name>`: a worktree the sanctioned provisioner, `scripts/new-worktree.sh`, did not make.
 *
 * WHY THIS EXISTS. Worktrees live at `.claude/worktrees/<name>` -- the location the `EnterWorktree`
 * tool uses natively -- and `scripts/hooks/worktree-create.mjs` routes that tool through
 * `scripts/new-worktree.sh` so each one is cut from `origin/main` onto `agent/<name>` with a probed
 * port pair and a rendered briefing. Since the tool and the script now agree on WHERE, location
 * carries no information and this guard does not look at it.
 *
 * What the tool and the script still disagree about is everything the script does after choosing
 * the path. When the settings file a session loaded registers no WorktreeCreate hook, as in a
 * checkout whose `.claude/settings.json` predates it, `EnterWorktree` silently falls back to
 * its native behaviour: branch `worktree-<name>`, cut from whatever `worktree.baseRef` names
 * (`fresh`, the default, takes `origin/<default branch>`; `head` takes the local HEAD), and no
 * `.worktree/CONTEXT.md`, so the briefing AGENTS.md @-imports is absent and the agent never reads
 * the rules of a shared repository. No `worktree.baseRef` value names `origin/main` itself: the
 * default branch is a GitHub setting outside this repository, `main` when checked on 2026-09-23,
 * which is the same reason `guard-git.mjs`'s PR-base rule will not infer it.
 *
 * Until 2026-10-08 this header, then `guard-git.mjs`'s, said Claude Code
 * snapshots hook configuration at session start, so that any session begun before the hook was
 * added fell back. It does not: a WorktreeCreate hook added to the settings file mid-session took
 * over `EnterWorktree` with no restart. The hooks documentation says such an edit is "normally" picked up, which
 * leaves an edit the file watcher missed as the other way a session can lack the hook.
 *
 * No incident here yet. Were this check wrong, it would let an agent do real work in a worktree with
 * no briefing, on a branch AGENTS.md § Git workflow does not provide for, cut from a base no file in
 * this repository chose.
 *
 * A WorktreeCreate hook cannot cover this, because the failure is that no WorktreeCreate hook ran.
 * This one is a PreToolUse Bash hook, so it fires on the agent's first command whether or not the
 * session's settings register a WorktreeCreate hook -- the only place left to catch it.
 *
 * THE SIGNAL IS THE BRANCH NAME. `new-worktree.sh` always names the branch `agent/<name>`; the
 * native fallback always names it `worktree-<name>`. The base cannot be the signal: while the
 * default branch is `main`, a `fresh` fallback starts from the same `origin/main` the script does,
 * and the two differ at most by how recently it was fetched. The name is cheap, needs no network,
 * and does not move as `origin/main` does. The base distance is measured only to put a number in
 * the message when there is one, and never decides, because a legitimately long-lived `agent/*`
 * branch may sit far behind `origin/main` for good reasons.
 *
 * IT REFUSES EVERY COMMAND, NOT JUST GIT: the agent is about to do real work against a commit it did
 * not choose, and every command it runs deepens that. Escaping does not need the shell --
 * `ExitWorktree` is a tool -- so refusing every Bash command leaves a way out rather than a
 * deadlock. It reads no command, so an unreadable payload changes only where it looks: the
 * process's own directory, as below.
 *
 * WHERE THE COMMAND RUNS, AND THE GIT IT ASKS, are as `guard-git.mjs` reads them, for the reasons its
 * `commandDir` and `gitOut` give: the payload's `cwd`, never `CLAUDE_PROJECT_DIR`, which stays at the
 * primary checkout after `EnterWorktree`; and git with no inherited `GIT_*` variable (`gitEnv` in
 * `_shared.mjs`), which would point git at another checkout.
 *
 * A FILE OF ITS OWN. Until 2026-10-08 this check lived in `guard-git.mjs`, beside its approval and
 * merge rules, so a change to this check alone was reviewed as a change to those rules, though it
 * decides nothing about an approval or a merge.
 * Where that loses: a change that weakens this check merges without a
 * person, and `scripts/hooks/worktree-hooks.selftest.mjs` is what holds it. It costs one
 * more Node process and three git calls on every Bash command, beside the guard's: a median of 84 ms
 * against the guard's 69 ms, 20 runs each on a payload from an `agent/*` worktree, Node 24.21.0 on a
 * macOS laptop, 2026-10-08.
 *
 *   printf '%s' '{"cwd":"<a worktree>","tool_input":{"command":"ls"}}' | node scripts/hooks/guard-unprovisioned-worktree.mjs
 *
 * Exit 2 refuses, with the reason on stderr, as `guard-git.mjs` does; exit 0 allows. NEEDS git on
 * `PATH`. Where git cannot answer -- no repository, git missing, a detached HEAD -- it allows the
 * command. Run by hand with no payload on stdin, it exits 0 with nothing to judge.
 */
import { spawnSync } from 'node:child_process'
import { TRUNK, gitEnv, readHookInput } from './_shared.mjs'

const TRUNK_REMOTE = `origin/${TRUNK}`

/** The directory the command will run in: the payload's `cwd`, or this process's own directory. */
function commandDir(input) {
  return typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
}

/** The trimmed stdout of a git command run in `dir`, or `null` if it fails or says nothing. */
function gitOut(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || typeof r.stdout !== 'string') return null
  const out = r.stdout.trim()
  return out === '' ? null : out
}

/** True only in a LINKED worktree, where `--git-dir` and `--git-common-dir` differ. */
function inLinkedWorktree(dir) {
  const gitDir = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const common = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return gitDir !== null && common !== null && gitDir !== common
}

/** `{ branch, behind }` when the worktree at `dir` is not on an `agent/*` branch, or `null`. */
function unprovisionedWorktree(dir) {
  const branch = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null || branch === 'HEAD') return null // detached; not a shape we judge
  if (branch.startsWith('agent/')) return null

  // For the message only. `null` whenever git cannot answer -- offline, no origin/main, a shallow
  // clone -- because the branch name has already decided and this must never be what blocks.
  let behind = null
  const counts = gitOut(dir, ['rev-list', '--left-right', '--count', `${TRUNK_REMOTE}...HEAD`])
  if (counts !== null) {
    const [left] = counts.split(/\s+/)
    if (/^\d+$/.test(left)) behind = Number(left)
  }
  return { branch, behind }
}

// Run by hand, with no payload on stdin: nothing to judge.
if (process.stdin.isTTY) process.exit(0)

// Read stdin BEFORE deciding anything, so the writer never meets a closed pipe.
const input = await readHookInput()
const dir = commandDir(input)
const unprovisioned = inLinkedWorktree(dir) ? unprovisionedWorktree(dir) : null
if (unprovisioned !== null) {
  const { branch, behind } = unprovisioned
  // A distance of 0 or an unanswerable one says nothing: while the default branch is the trunk, a
  // native fallback can start from the same commit the script would have.
  const distance = behind !== null && behind > 0 ? `, ${behind} commit(s) behind ${TRUNK_REMOTE}` : ''
  process.stderr.write(
    'BLOCKED by repository policy: ' +
      `this worktree is on '${branch}', not an agent/* branch${distance}. Every worktree here is ` +
      `provisioned by scripts/new-worktree.sh, which cuts agent/<name> from ${TRUNK_REMOTE} and ` +
      "renders the briefing .worktree/CONTEXT.md. This checkout may lack the expected code " +
      "or briefing. Do not work here. Leave the worktree and re-create it through the " +
      "provision script before continuing.\n",
  )
  process.exit(2)
}
process.exit(0)

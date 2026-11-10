/**
 * PreToolUse hook on Bash. Refuses every command but the setup script in a linked worktree whose
 * branch is not `agent/<name>`: a worktree that `scripts/setup-worktree.mjs` has not set up yet.
 *
 * WHY THIS EXISTS. A worktree here is made by Claude Code itself (`EnterWorktree`,
 * `claude --worktree`, a subagent's `isolation: "worktree"`) or, for a CLI with no worktree tool, by
 * `scripts/new-worktree.sh`. Either way, `scripts/setup-worktree.mjs` is what names the branch for
 * its issue, sets the commit identity, installs the packages and renders the briefing
 * `.worktree/CONTEXT.md`. Nothing runs that script for a worktree Claude Code made: no hook fires
 * after it makes one. So a session that skips it works on a `worktree-<name>` branch, which names
 * no issue for the delivery hook to find, under the operator's commit identity, with no briefing,
 * so it never reads the rules of a shared repository. This hook is what makes the setup the first
 * command there: it refuses every other one until the branch says the setup ran.
 *
 * Until 2026-11-10 a WorktreeCreate hook routed Claude Code's tool through the worktree script, and
 * this guard caught the session whose settings had lost that hook. The setup script's header says
 * what that hook cost and why it went.
 *
 * No incident here yet. Were this check wrong, it would let an agent do real work in a worktree with
 * no briefing, on a branch AGENTS.md § Git workflow does not provide for.
 *
 * THE SIGNAL IS THE BRANCH NAME. The setup's first step renames the branch to `agent/<name>`, and
 * `scripts/new-worktree.sh` cuts it under that name, so a linked worktree on any other branch has
 * not been set up. The name is cheap, needs no network, and does not move as `origin/main` does.
 * The base distance is measured only to put a number in the message when there is one, and never
 * decides, because a legitimately long-lived `agent/*` branch may sit far behind `origin/main` for
 * good reasons. Where it loses: a setup that renamed the branch and then failed, at the briefing or
 * the install, leaves a worktree this guard reads as set up; the setup's own exit status and its
 * message are what say so then.
 *
 * IT REFUSES EVERY OTHER COMMAND, NOT JUST GIT: the agent is about to do real work, and every
 * command it runs deepens that. The one it lets through is the setup script, run plainly as
 * `node scripts/setup-worktree.mjs` with its arguments and nothing after it (`SETUP` below): a
 * command that chains anything onto it is not that command. The refusal names the forms, a pipe, a
 * redirect and a second command, because "as its own command" was not read that way: in the two
 * Work runs of 2026-11-10 a session piped the setup into `tail`, once after being refused for a
 * chain, and each try cost a refused call. Leaving does not need the shell either
 * -- `ExitWorktree` is a tool -- so refusing leaves a way out rather than a deadlock. With a payload
 * it cannot read it sees no setup command, and refuses.
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

/**
 * The setup script, run plainly from the worktree's root: `node scripts/setup-worktree.mjs`, then
 * only words of letters, digits, dot, dash and underscore, which its name, `--no-install` and
 * `--task <ref>` all are. No separator, quote, variable or path can follow it.
 */
const SETUP = /^\s*node\s+(?:\.\/)?scripts\/setup-worktree\.mjs(?:\s+[A-Za-z0-9._-]+)*\s*$/

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
const command = input?.tool_input?.command
if (unprovisioned !== null && !(typeof command === 'string' && SETUP.test(command))) {
  const { branch, behind } = unprovisioned
  // A distance of 0 or an unanswerable one says nothing: while the default branch is the trunk, a
  // native fallback can start from the same commit the script would have.
  const distance = behind !== null && behind > 0 ? `, ${behind} commit(s) behind ${TRUNK_REMOTE}` : ''
  process.stderr.write(
    'BLOCKED by repository policy: ' +
      `this worktree is on '${branch}', not an agent/* branch${distance}, so it has not been set up. ` +
      'Run `node scripts/setup-worktree.mjs <issue id>-<slug>` alone, from the ' +
      "worktree's root, with no pipe, redirect or second command. " +
      'It names the branch for its issue, sets the commit identity, installs ' +
      'the packages and writes the briefing .worktree/CONTEXT.md. No other command runs here ' +
      'until it has.\n',
  )
  process.exit(2)
}
process.exit(0)

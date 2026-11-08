/**
 * The protected test that reproduces ss-4ub: from a linked worktree, `guard-git.mjs` must judge the
 * branch a command writes, not every branch it names. A branch created or reset on an agent's name
 * from `main` writes the agent's branch, and `main` is only its start point.
 *
 * THE FAILURE THIS PREVENTS. On 2026-11-08 a probe during ss-y98 found that the guard refused
 * `git branch -f agent/x main` with its switch-or-rewrite reason, and allowed
 * `git switch -C agent/x main`, which resets the same branch. The `branch` rule refused when any word
 * named a protected branch, so it read the start point as the branch written. The fresh-context
 * review of ss-y98 found `git switch --create agent/x main` refused the same way, because the
 * create rule knew only the short options `-b`, `-B`, `-c` and `-C`. The same probe found the other
 * side of that gap: `git switch -Crelease agent/lane`, `git checkout -Brelease agent/lane` and
 * `git switch --force-create=release agent/lane` were allowed, and each resets `release`, because
 * the rule found no create option there and judged only the start point. A guard that refuses the
 * forms a lane's own work needs is one a session learns to route around.
 *
 * Each allowed case is a form git reads as writing `agent/x`, in the spellings git accepts: the
 * long option, its `=` form, and a short option with its value joined on. The refused cases are the
 * same spellings writing `main` or `release`, and the deletes and renames that write a protected
 * branch whatever it is named beside. Without them a fix that stopped reading a create or a reset
 * option at all would pass. The control is `git status` in the lane, and the refused commands pass
 * in the primary checkout, where the git rules do not apply. Each refusal is asserted by its reason.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-branch-start.selftest.mjs)
 *
 * Needs `git` and Node. It writes only under the temporary directory. Its own git reads no personal
 * config, and the guard, which drops every `GIT_*` variable, gets an empty `HOME` and
 * `XDG_CONFIG_HOME` so its git reads none either. It reads no policy, because this rule does not.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard-git.mjs')
const CHECKOUT_RULE = 'you cannot switch to or rewrite a long-lived branch'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}
const why = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 200))}`

// Every GIT_* variable dropped and no personal config read, so a run from a pre-push hook cannot
// reach the real repository (`worktree-hooks.selftest.mjs` has the incident).
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'GUARD_GIT_ROOT')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-branch-start-'))
try {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })
  const primary = join(scratch, 'primary')
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  writeFileSync(join(primary, 'f.txt'), 'one\n')
  git(primary, 'add', 'f.txt')
  git(primary, '-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'commit', '-qm', 'init')
  git(primary, 'branch', 'release')
  const lane = join(primary, '.claude', 'worktrees', 'lane')
  git(primary, 'worktree', 'add', '-q', '-b', 'agent/lane', lane, 'main')
  const home = join(scratch, 'home')
  mkdirSync(home)
  const GUARD_ENV = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CLAUDE_PROJECT_DIR: primary }

  /** guard-git on `command` typed from `dir`. */
  const guard = (dir, command) => {
    const r = spawnSync('node', [GUARD], { input: JSON.stringify({ cwd: dir, tool_input: { command } }), cwd: dir, env: GUARD_ENV, encoding: 'utf8' })
    return { code: r.status ?? 1, stderr: r.stderr ?? '' }
  }

  console.log('guard-git: a branch written from main, which writes only the branch named')
  for (const [label, command] of [
    ['the undoctored control, a read', 'git status'],
    ['a reset of an agent branch to main by branch -f', 'git branch -f agent/x main'],
    ['the same by branch --force', 'git branch --force agent/x main'],
    ['a branch created from main by switch --create', 'git switch --create agent/x main'],
    ['a branch reset to main by switch --force-create', 'git switch --force-create agent/x main'],
    ['a branch created from main by switch --create=', 'git switch --create=agent/x main'],
    ['a branch created from main by switch -c with its name joined on', 'git switch -cagent/x main'],
    ['a branch reset to main by checkout -B with its name joined on', 'git checkout -Bagent/x main'],
  ]) {
    const r = guard(lane, command)
    check(`the lane allows ${label}`, r.code === 0, why(r))
  }

  const refused = [
    ['a reset of main by branch -f', 'git branch -f main HEAD'],
    ['a reset of release by branch --force', 'git branch --force release agent/lane'],
    ['a delete of release', 'git branch -D release'],
    ['a rename of the lane branch to main', 'git branch -m main'],
    ['a rename of main to an agent name', 'git branch -m main agent/x'],
    ['a rename of an agent branch to release by -M', 'git branch -M agent/lane release'],
    ['a branch named release created by switch --create', 'git switch --create release main'],
    ['a reset of release by switch --force-create=', 'git switch --force-create=release agent/lane'],
    ['a reset of release by switch -C with its name joined on', 'git switch -Crelease agent/lane'],
    ['a reset of release by checkout -B with its name joined on', 'git checkout -Brelease agent/lane'],
    ['a reset of release by checkout -fB, a cluster', 'git checkout -fB release agent/lane'],
  ]
  console.log('guard-git: a branch command that writes main or release, in the lane')
  for (const [label, command] of refused) {
    const r = guard(lane, command)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(CHECKOUT_RULE), why(r))
  }
  console.log('guard-git: the same commands in the primary checkout')
  for (const [label, command] of refused) {
    const r = guard(primary, command)
    check(`control: the primary checkout allows ${label}`, r.code === 0, why(r))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git branch-start selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git branch-start selftest: every case passed')

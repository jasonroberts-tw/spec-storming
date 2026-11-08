/**
 * The protected test that reproduces ss-oll: from a linked worktree, `guard-git.mjs` must refuse
 * `git update-ref` on `main` or `release`, and a `git branch` copy onto either, by its
 * switch-or-rewrite reason.
 *
 * THE FAILURE THIS PREVENTS. On 2026-11-08 the fresh-context review of ss-y98 probed the guard from
 * a lane on `agent/lane` with one commit ahead. It allowed `git update-ref refs/heads/main HEAD` and
 * `git branch -C agent/lane release`, and real git then moved `main` from 38a5188 to a8fa7d3 and
 * overwrote `release` the same way. No rule judged `update-ref`, and the `branch` rule knew no copy
 * option. `AGENTS.md` § "Git workflow" says never to rewrite a protected branch from a worktree, and
 * the guard's README row said it refused a rewrite of either.
 *
 * Each refused case names `main` or `release` as the ref it writes: `update-ref` setting or deleting
 * one, with `-m` or `--no-deref` beside it, and `branch -c`, `-C` or `--copy` copying onto one.
 * `git update-ref main HEAD` writes no branch. It writes a ref named `main` in the git directory
 * every checkout shares, and a scratch run showed the primary checkout then resolving `main` to the
 * lane's commit before the branch. The allowed cases are the same commands writing an agent branch, with `main` or
 * `release` as the value, the start point or the `-m` reason, so a fix that refused every
 * `update-ref` or every copy would fail. The control is `git status` in the lane, and the refused
 * commands pass in the primary checkout, where the git rules do not apply. Each refusal is asserted
 * by its reason.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-ref-rewrite.selftest.mjs)
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

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-ref-rewrite-'))
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

  console.log('guard-git: update-ref and branch copies that write an agent branch')
  for (const [label, command] of [
    ['the undoctored control, a read', 'git status'],
    ['an update-ref of an agent branch', 'git update-ref refs/heads/agent/x HEAD'],
    ['an update-ref of an agent branch to main', 'git update-ref refs/heads/agent/x refs/heads/main'],
    ['an update-ref delete of an agent branch', 'git update-ref -d refs/heads/agent/x'],
    ['an update-ref of an agent branch whose -m reason is main', 'git update-ref -m main refs/heads/agent/x HEAD'],
    ['a copy of release onto an agent branch', 'git branch -c release agent/x'],
    ['a forced copy of the lane branch onto an agent branch', 'git branch -C agent/lane agent/x'],
  ]) {
    const r = guard(lane, command)
    check(`the lane allows ${label}`, r.code === 0, why(r))
  }

  const refused = [
    ['an update-ref of main', 'git update-ref refs/heads/main HEAD'],
    ['an update-ref of main by its short name', 'git update-ref main HEAD'],
    ['an update-ref delete of release', 'git update-ref -d refs/heads/release'],
    ['an update-ref of release with a -m reason', 'git update-ref -m why refs/heads/release HEAD'],
    ['an update-ref of main with --no-deref', 'git update-ref --no-deref refs/heads/main HEAD'],
    ['a forced copy of the lane branch onto release', 'git branch -C agent/lane release'],
    ['a copy of the lane branch onto main', 'git branch -c agent/lane main'],
    ['a copy onto release by --copy --force', 'git branch --copy --force agent/lane release'],
    ['a copy onto release by -c and a separate -f', 'git branch -c -f agent/lane release'],
    ['a forced copy of the current branch onto release', 'git branch -C release'],
  ]
  console.log('guard-git: update-ref and branch copies that write main or release, in the lane')
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
  console.log(`guard-git ref-rewrite selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git ref-rewrite selftest: every case passed')

/**
 * The protected test that reproduces ss-4v3: from a linked worktree, `guard-git.mjs` must refuse
 * every `git update-ref --stdin`, because the refs it writes come on its input, which the guard
 * cannot read. The refusal names the form that passes, one `git update-ref <ref> <value>` per ref.
 *
 * THE FAILURE THIS PREVENTS. On 2026-11-08, once ss-oll had the guard refuse `git update-ref` on
 * `main` or `release`, a probe from a linked worktree found
 * `echo 'update refs/heads/main HEAD' | git update-ref --stdin` allowed: the guard splits the pipe,
 * and the `update-ref` statement names no ref. Run from a lane in a scratch repository, the same
 * input moved `refs/heads/main` to the lane's commit. The operator chose to refuse every
 * `update-ref --stdin` from a worktree, so the worst case is a lane that names each of its own refs
 * on a command line of its own.
 *
 * Each refused case reads its refs from its input: piped, redirected from a file, with `-z`, or with
 * no input at all. The allowed cases are an `update-ref` that names an agent branch on its command
 * line, and each refused command in the primary checkout, where the git rules do not apply. The
 * control is `git status` in the lane. Each refusal is asserted by its reason, and the reason by the
 * form it names.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-update-ref-stdin.selftest.mjs)
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
const STDIN_RULE = 'cannot read the refs'
const PASSING_FORM = 'one `git update-ref <ref> <value>` per ref'

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

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-update-ref-stdin-'))
try {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })
  const primary = join(scratch, 'primary')
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  writeFileSync(join(primary, 'f.txt'), 'one\n')
  git(primary, 'add', 'f.txt')
  git(primary, '-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'commit', '-qm', 'init')
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

  console.log('guard-git: update-ref with its refs on the command line')
  for (const [label, command] of [
    ['the undoctored control, a read', 'git status'],
    ['an update-ref of an agent branch', 'git update-ref refs/heads/agent/x HEAD'],
  ]) {
    const r = guard(lane, command)
    check(`the lane allows ${label}`, r.code === 0, why(r))
  }

  const refused = [
    ['an update-ref --stdin fed by a pipe', "echo 'update refs/heads/main HEAD' | git update-ref --stdin"],
    ['an update-ref --stdin fed by a file', 'git update-ref --stdin < refs.txt'],
    ['an update-ref -z --stdin', 'git update-ref -z --stdin'],
    ['an update-ref --stdin with -m before it', 'git update-ref -m why --stdin'],
  ]
  console.log('guard-git: update-ref --stdin, in the lane')
  for (const [label, command] of refused) {
    const r = guard(lane, command)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(STDIN_RULE), why(r))
  }
  const named = guard(lane, 'git update-ref --stdin')
  check('the refusal names the form that passes', named.stderr.includes(PASSING_FORM), why(named))
  console.log('guard-git: the same commands in the primary checkout')
  for (const [label, command] of refused) {
    const r = guard(primary, command)
    check(`control: the primary checkout allows ${label}`, r.code === 0, why(r))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git update-ref-stdin selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git update-ref-stdin selftest: every case passed')

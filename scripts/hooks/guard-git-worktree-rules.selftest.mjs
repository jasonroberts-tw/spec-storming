/**
 * The git guard's worktree rules that `worktree-hooks.selftest.mjs` gives no case: `guard-git.mjs`
 * run as the harness runs it, from a linked worktree of a scratch repository, on a switch to or a
 * rewrite of a protected branch, a merge of one into the lane's branch, `git gc`, `git prune` and
 * `git reflog expire`, `git push --all` and `--mirror`, and a payload it cannot read.
 *
 * THE FAILURE THIS PREVENTS. On 2026-11-08 the fresh-context review of ss-9ec found that each of
 * these five rules could be deleted from the guard and every selftest would still pass, because no
 * selftest held the rule's refusal text (ss-y98). A rule nothing holds is the one an edit to the
 * guard loses without a word, and the next session in a worktree then rewrites `main`, merges it
 * into its branch, prunes objects a sibling worktree still needs, or runs a command the guard never
 * read.
 *
 * On 2026-11-08 the review of ss-4ub's fix found that the reset and copy rules read the value of
 * `--sort` or `--format` as the branch written, so `git branch -f --sort refname release HEAD` and
 * `git branch -C agent/lane release --sort x` were allowed, and git reset `release` in each. The
 * cases for those forms are here, beside the other rewrites of a protected branch.
 *
 * Each refused case changes one thing from an allowed case beside it, and is asserted by the
 * rule's own reason, so a case refused by another rule fails. The undoctored control is
 * `git status` in the lane. The other controls are the allowed forms each rule must leave alone,
 * such as a branch created from `main`, a file restored from it and the rebase the briefing asks
 * for, and the refused commands run in the primary checkout, where the git rules do not apply.
 * Without them a guard that refused every git call in a worktree would pass. An unreadable payload
 * is refused in the lane and in a stray worktree directory, and allowed in the primary checkout.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-worktree-rules.selftest.mjs)
 *
 * Needs `git` and Node. It writes only under the temporary directory. It reads no personal git
 * config, and nor does the guard's own git. The guard runs git with every `GIT_*` variable dropped
 * (`gitEnv` in `_shared.mjs`), so the guard gets an empty `HOME` and `XDG_CONFIG_HOME` instead. The
 * guard's git still reads the system git config, which only a `GIT_*` variable turns off. It reads
 * no policy, because none of these rules does.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard-git.mjs')

// Each rule's own refusal, as `guard-git.mjs` words it.
const CHECKOUT_RULE = 'you cannot switch to or rewrite a long-lived branch'
const MERGE_RULE = 'rather than merging main into your branch'
const OBJECTS_RULE = 'the object store is shared with sibling worktrees currently in use'
const PUSH_RULE = 'you cannot push to a long-lived branch'
const UNREADABLE_RULE = 'the hook payload could not be read, so this command cannot be checked'

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

// Every GIT_* variable dropped and no personal config read by this file's git, so a run from a
// pre-push hook cannot reach the real repository (`worktree-hooks.selftest.mjs` has the incident).
// The runner's root override goes too, so no case reads another checkout's policy.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'GUARD_GIT_ROOT')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-worktree-'))
try {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })
  const primary = join(scratch, 'primary')
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  writeFileSync(join(primary, 'f.txt'), 'one\n')
  git(primary, 'add', 'f.txt')
  git(primary, '-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'commit', '-qm', 'init')
  git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const lane = join(primary, '.claude', 'worktrees', 'lane')
  git(primary, 'worktree', 'add', '-q', '-b', 'agent/lane', lane, 'main')
  // What a worktree removed under a live session leaves: a directory under the worktrees folder
  // with no `.git` file, where git answers for the primary checkout.
  const stray = join(primary, '.claude', 'worktrees', 'gone')
  mkdirSync(stray, { recursive: true })
  // The guard drops GIT_CONFIG_GLOBAL with every GIT_* variable, so its git would find the personal
  // config through HOME. An empty HOME leaves it none.
  const home = join(scratch, 'home')
  mkdirSync(home)
  const GUARD_ENV = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CLAUDE_PROJECT_DIR: primary }

  /** guard-git on `stdin`, run in `dir`, as the harness runs it there. */
  const raw = (dir, stdin) => {
    const r = spawnSync('node', [GUARD], { input: stdin, cwd: dir, env: GUARD_ENV, encoding: 'utf8' })
    return { code: r.status ?? 1, stderr: r.stderr ?? '' }
  }
  /** guard-git on `command` typed from `dir`. */
  const guard = (dir, command) => raw(dir, JSON.stringify({ cwd: dir, tool_input: { command } }))

  console.log('guard-git: the forms each worktree rule leaves alone')
  for (const [label, command] of [
    ['the undoctored control, a read', 'git status'],
    ['a branch created from main', 'git switch -c agent/next main'],
    ['a branch created from main by checkout -b', 'git checkout -b agent/next main'],
    ['a file restored from main', 'git checkout main -- f.txt'],
    ['a switch to another agent branch', 'git switch agent/other'],
    ['a list of branches that names main', 'git branch --list main'],
    ['a reset of an agent branch to main after a --sort and its key', 'git branch -f --sort refname agent/x main'],
    ['a forced copy onto an agent branch before a --sort and its key', 'git branch -C agent/lane agent/x --sort refname'],
    ['the rebase the briefing asks for', 'git rebase origin/main'],
    ['a merge of another agent branch', 'git merge agent/other'],
    ['a reflog read', 'git reflog show'],
    ['a push of the lane branch', 'git push origin agent/lane'],
  ]) {
    const r = guard(lane, command)
    check(`control: the lane allows ${label}`, r.code === 0, why(r))
  }

  // Each command below is refused in the lane by the reason beside it. Run in the primary checkout,
  // where the git rules do not apply, each one but a merge must pass, or the case could be refused
  // by a rule that fires everywhere. The primary-merge rule refuses a merge there whatever it names.
  const refused = [
    ['a switch to main', 'git switch main', CHECKOUT_RULE],
    ['a checkout of release', 'git checkout release', CHECKOUT_RULE],
    ['a rewrite of main by checkout -B', 'git checkout -B main', CHECKOUT_RULE],
    ['a branch created from main and named release', 'git switch -c release main', CHECKOUT_RULE],
    ['a reset of main by branch -f', 'git branch -f main HEAD', CHECKOUT_RULE],
    ['a delete of release by branch -D', 'git branch -D release', CHECKOUT_RULE],
    ['a reset of release by branch -f after a --sort and its key', 'git branch -f --sort refname release HEAD', CHECKOUT_RULE],
    ['a reset of release by branch -f after a --format and its format', 'git branch -f --format x release HEAD', CHECKOUT_RULE],
    ['a reset of release by a --sort and its key before the -f', 'git branch --sort refname -f release HEAD', CHECKOUT_RULE],
    ['a forced copy onto release before a --sort and its key', 'git branch -C agent/lane release --sort x', CHECKOUT_RULE],
    ['a merge of main', 'git merge main', MERGE_RULE],
    ['a merge of origin/main', 'git merge --no-ff origin/main', MERGE_RULE],
    ['a merge of release', 'git merge release', MERGE_RULE],
    ['a gc', 'git gc', OBJECTS_RULE],
    ['a gc that prunes now', 'git gc --prune=now', OBJECTS_RULE],
    ['a prune', 'git prune', OBJECTS_RULE],
    ['a reflog expire', 'git reflog expire --expire=now --all', OBJECTS_RULE],
    ['a push --all', 'git push --all origin', PUSH_RULE],
    ['a push --mirror', 'git push origin --mirror', PUSH_RULE],
    ['a push --all inside bash -c', "bash -c 'git push --all origin'", PUSH_RULE],
  ]
  console.log('guard-git: each worktree rule, in the lane')
  for (const [label, command, reason] of refused) {
    const r = guard(lane, command)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(reason), why(r))
  }
  console.log('guard-git: the same commands in the primary checkout')
  for (const [label, command] of refused) {
    if (command.includes(' merge ')) continue
    const r = guard(primary, command)
    check(`control: the primary checkout allows ${label}`, r.code === 0, why(r))
  }

  console.log('guard-git: a payload it cannot read')
  for (const [label, dir, stdin] of [
    ['stdin that is not JSON, in the lane', lane, 'not json at all'],
    ['a payload with no command, whose cwd names the lane', primary, JSON.stringify({ cwd: lane, tool_input: {} })],
    ['a command that is not a string, in the lane', lane, JSON.stringify({ cwd: lane, tool_input: { command: 42 } })],
    ['stdin that is not JSON, in a stray worktree directory', stray, 'not json at all'],
  ]) {
    const r = raw(dir, stdin)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(UNREADABLE_RULE), why(r))
  }
  for (const [label, stdin] of [
    ['stdin that is not JSON', 'not json at all'],
    ['a payload with no command', JSON.stringify({ cwd: primary, tool_input: {} })],
  ]) {
    const r = raw(primary, stdin)
    check(`control: the primary checkout allows ${label}`, r.code === 0, why(r))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git worktree-rules selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git worktree-rules selftest: every case passed')

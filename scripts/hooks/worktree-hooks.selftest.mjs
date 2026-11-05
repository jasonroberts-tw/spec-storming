/**
 * Self-test for scripts/hooks/worktree-create.mjs, scripts/hooks/worktree-remove.mjs,
 * scripts/render-worktree-context.mjs with the briefing template it renders,
 * scripts/new-worktree.sh's choice of which copy of that template renders, its run beside
 * another that holds `.git/config.lock`
 * and the branch a failed run of it made, and for the hook registrations in
 * the rendered Claude settings: each must load
 * whatever the session's working directory is (the last section says what broke).
 *
 * Covers the halves of the contract that are cheap to exercise and easy to get wrong: what the hooks
 * accept on stdin, what they refuse, and -- for the remove hook -- that stdout stays clean and the
 * sandbox fallback actually deletes a directory `git worktree remove` will not touch. It deliberately
 * does NOT provision a real worktree: `git worktree add` needs the primary checkout, and a
 * worktree-isolated session is refused it by scripts/hooks/guard-git.mjs. That one round trip is
 * verified by running the create hook from the primary checkout. The new-worktree
 * case runs the script only in a scratch repository of its own.
 *
 *   node scripts/hooks/worktree-hooks.selftest.mjs
 *
 * Needs `git`, `bash` and a POSIX `sh` on PATH. It reads nothing outside the temporary directory
 * but this checkout's own files. The render and new-worktree cases bind loopback ports for a moment,
 * as the renderer's port probe does.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderIntegrations } from '../../tools/integrations/render.mjs'

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)))
const CREATE = join(HOOKS, 'worktree-create.mjs')
const REMOVE = join(HOOKS, 'worktree-remove.mjs')

let failures = 0

/**
 * Run a hook with `input` on stdin. Never throws; the exit code is part of what is asserted.
 *
 * `spawnSync` rather than `execFileSync` because stderr has to survive a SUCCESSFUL run:
 * `execFileSync` returns stdout only and reaches stderr through the thrown error, so on exit 0 it
 * dropped the stream on the floor. These hooks report everything they did on stderr -- stdout is
 * reserved for the harness -- which makes stderr the only evidence of what a zero-exit run actually
 * did.
 */
function run(script, input) {
  const r = spawnSync('node', [script], { input, encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}

console.log('create hook: input it must refuse')
for (const [label, input] of [
  ['non-JSON stdin', 'not json at all'],
  ['no name field', '{"hook_event_name":"WorktreeCreate"}'],
  ['name with a slash', '{"hook_event_name":"WorktreeCreate","name":"a/b"}'],
  ['name with a backslash', '{"hook_event_name":"WorktreeCreate","name":"a\\\\b"}'],
  ['dot-segment name', '{"hook_event_name":"WorktreeCreate","name":".."}'],
  ['traversal name', '{"hook_event_name":"WorktreeCreate","name":"../escape"}'],
  ['empty name', '{"hook_event_name":"WorktreeCreate","name":""}'],
  ['non-string name', '{"hook_event_name":"WorktreeCreate","name":42}'],
  ['leading-dot name', '{"hook_event_name":"WorktreeCreate","name":".hidden"}'],
]) {
  const r = run(CREATE, input)
  // A refusal must be non-zero AND must not print a path, or the harness would try to use one.
  check(
    label,
    r.code !== 0 && r.stdout.trim() === '',
    `code=${r.code} stdout=${JSON.stringify(r.stdout)}`,
  )
}

console.log('remove hook: input it must refuse')
for (const [label, input] of [
  ['non-JSON stdin', 'not json at all'],
  ['no worktree_path', '{"hook_event_name":"WorktreeRemove"}'],
  ['empty worktree_path', '{"hook_event_name":"WorktreeRemove","worktree_path":""}'],
]) {
  const r = run(REMOVE, input)
  check(label, r.code !== 0, `code=${r.code}`)
}

console.log('remove hook: the sandbox fallback')
// A plain directory is not a registered worktree, so `git worktree remove` fails on it exactly as it
// does under the sandbox's bind mounts. The direct-removal branch is what must clear it.
const scratch = mkdtempSync(join(tmpdir(), 'wt-remove-'))
const victim = join(scratch, 'not-a-worktree')
mkdirSync(join(victim, 'nested'), { recursive: true })
writeFileSync(join(victim, 'nested', 'file.txt'), 'content')
const removed = run(
  REMOVE,
  JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: victim }),
)
check('exits zero', removed.code === 0, `code=${removed.code} stderr=${removed.stderr}`)
check('directory is gone', !existsSync(victim))
check('stdout stays empty', removed.stdout.trim() === '', JSON.stringify(removed.stdout))

console.log('remove hook: a path that cannot be removed')
// Nothing to delete is still "gone", so this must succeed rather than fail on a missing directory.
const absent = run(
  REMOVE,
  JSON.stringify({
    hook_event_name: 'WorktreeRemove',
    worktree_path: join(scratch, 'never-existed'),
  }),
)
check('absent path exits zero', absent.code === 0, `code=${absent.code} stderr=${absent.stderr}`)

/* --------------------------------------------------------------------------------------------- *
 * guard-unprovisioned-worktree: the unprovisioned-worktree tripwire.
 *
 * The one failure the WorktreeCreate hook cannot catch is the one where no WorktreeCreate hook ran.
 * A session whose settings file registers no WorktreeCreate hook gets `EnterWorktree`'s native
 * behaviour instead: a `worktree-<name>` branch cut from `origin/main` rather than `agent/<name>` cut
 * from `origin/main`. Since both now use the same LOCATION, the branch name is the discriminator.
 * `guard-unprovisioned-worktree.mjs` is a PreToolUse Bash hook, so it fires whether or not that hook
 * is registered -- and this asserts it does. Until 2026-10-08 the check lived in `guard-git.mjs`,
 * which the high-risk floor holds; `guard-git.mjs` must now let the same command through, or the
 * check would still be on the floor.
 *
 * Unlike the create-hook cases above, this one CAN provision real worktrees, because it builds a
 * throwaway repository in a temp directory. The header's "no real worktree" constraint is about
 * `git worktree add` against THIS repository from an isolated session; a scratch repo is untouched
 * by it.
 * --------------------------------------------------------------------------------------------- */
console.log('guard-unprovisioned-worktree: the unprovisioned-worktree tripwire')
const GUARD = join(HOOKS, 'guard-git.mjs')
const PROVISION_GUARD = join(HOOKS, 'guard-unprovisioned-worktree.mjs')
const repo = mkdtempSync(join(tmpdir(), 'wt-guard-'))
const primary = join(repo, 'primary')

/**
 * The environment for the scratch repository, with every `GIT_*` variable removed.
 *
 * THIS IS NOT HYGIENE, IT IS THE DIFFERENCE BETWEEN A TEST AND AN INCIDENT. Run from a linked
 * worktree, which is where agents push here, `git push` exports `GIT_DIR` (that worktree's absolute
 * git directory) into its pre-push hook, and `git commit` exports it into pre-commit with an
 * absolute `GIT_INDEX_FILE`, so a `git` call made from either hook inherits them and operates on
 * THE REAL REPOSITORY no matter what `cwd` it is given. From the primary checkout neither hook gets
 * `GIT_DIR`, pre-commit gets the relative `GIT_INDEX_FILE=.git/index`, and no hook from either
 * kind of checkout gets `GIT_WORK_TREE`. Measured on Git 2.54.0 (Apple Git-157) and Git 2.55.0 on
 * 2026-10-03, in scratch repositories; `tools/lib/git-env.ts` has the rest. Run without this scrub,
 * these cases registered both scratch worktrees against the actual repo, created their branches in
 * it, wrote `user.email=selftest@example.invalid` into `.git/config` -- which would have
 * misattributed every later commit -- and flipped `core.bare` to `true` on the primary checkout. It
 * passed under `lefthook run pre-push`, where those variables are absent, and failed only under a
 * real push: the worst possible split, because the failing run is the one that also does the damage.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are pinned to /dev/null for the same reason in the
 * other direction: the scratch repo must not read or write the developer's own git configuration.
 */
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/** Run a git command in the scratch repo. Throws on failure, which fails the selftest loudly. */
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV, encoding: 'utf8' })
writeFileSync(join(primary, 'f.txt'), 'hi\n')
git(primary, 'add', 'f.txt')
// Identity via -c, so the scratch repo needs no config file written to it at all.
const AS = ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest']
git(primary, ...AS, 'commit', '-qm', 'init')
// `origin/main` has to exist for the base-distance corroboration to have anything to measure.
git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
// Both worktrees sit in the NEW sanctioned location; only the branch name separates them.
git(primary, 'worktree', 'add', '-q', '.claude/worktrees/native', '-b', 'worktree-native', 'HEAD')
git(primary, 'worktree', 'add', '-q', '.claude/worktrees/ours', '-b', 'agent/ours', 'HEAD')

/**
 * Run guard-git as the harness runs it on a command typed from `dir`, in a session that started in
 * the primary checkout: the process in `dir`, the payload's `cwd` naming `dir`, and
 * `CLAUDE_PROJECT_DIR` naming the primary checkout, where the harness keeps it after `EnterWorktree`
 * (https://code.claude.com/docs/en/worktrees.md, the note "Hook paths don't follow the worktree").
 *
 * Until 2026-09-25 this set `CLAUDE_PROJECT_DIR` to `dir`, which the harness never does, and so it
 * passed over a guard that read that variable, judged the primary checkout, and applied no git rule
 * in any worktree a session had entered.
 *
 * `payloadDir` moves the payload's `cwd` away from the process's directory, for the cases that show
 * which of the two decides; `null` leaves it out of the payload. `env` is added to the guard's
 * environment, for the cases an inherited `GIT_DIR` would mislead. `hook` is the script run,
 * `guard-git.mjs` unless a case names another Bash hook.
 */
function guardFrom(dir, { command = 'echo hello', payloadDir = dir, env = {}, hook = GUARD } = {}) {
  const payload = { tool_input: { command } }
  if (payloadDir !== null) payload.cwd = payloadDir
  try {
    execFileSync('node', [hook], {
      input: JSON.stringify(payload),
      cwd: dir,
      env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: primary, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, stderr: '' }
  } catch (err) {
    return { code: err.status ?? 1, stderr: err.stderr ?? '' }
  }
}

const nativeDir = join(primary, '.claude', 'worktrees', 'native')
const PROVISION_RULE = 'not an agent/* branch'
const native = guardFrom(nativeDir, { hook: PROVISION_GUARD })
check(
  'a worktree-* branch is refused, by its reason',
  native.code === 2 && native.stderr.includes(PROVISION_RULE),
  `code=${native.code} ${JSON.stringify(native.stderr.slice(0, 200))}`,
)
check(
  'the refusal names the branch',
  native.stderr.includes("'worktree-native'"),
  JSON.stringify(native.stderr.slice(0, 200)),
)
// The hook reads no command, so an unreadable payload changes only where it looks: the process's
// directory, which is still the native worktree.
const nativeNoCwd = guardFrom(nativeDir, { hook: PROVISION_GUARD, payloadDir: null })
check(
  "with no cwd in the payload, the process's directory decides, and it is refused",
  nativeNoCwd.code === 2 && nativeNoCwd.stderr.includes(PROVISION_RULE),
  `code=${nativeNoCwd.code} ${JSON.stringify(nativeNoCwd.stderr.slice(0, 200))}`,
)
// An inherited `GIT_DIR` naming the primary checkout's `.git` would make git answer for the primary
// checkout, find no linked worktree and allow the command, as it did the guard until 2026-10-06;
// the hook runs its git with no `GIT_*` variable, as the guard does.
const nativeGitDir = guardFrom(nativeDir, { hook: PROVISION_GUARD, env: { GIT_DIR: join(primary, '.git') } })
check(
  'an inherited GIT_DIR naming the primary checkout does not move the checkout judged',
  nativeGitDir.code === 2 && nativeGitDir.stderr.includes(PROVISION_RULE),
  `code=${nativeGitDir.code} ${JSON.stringify(nativeGitDir.stderr.slice(0, 200))}`,
)
// The check left the floor's guard: the same command there passes it.
const nativeByGuard = guardFrom(nativeDir)
check(
  'guard-git.mjs no longer refuses a command in a worktree-* worktree',
  nativeByGuard.code === 0,
  `code=${nativeByGuard.code} ${JSON.stringify(nativeByGuard.stderr.slice(0, 200))}`,
)
// The scratch worktree starts at origin/main, as a `fresh` fallback does while the default branch is
// the trunk, so the refusal must claim neither a distance nor a base other than origin/main.
check(
  'at distance 0 the refusal makes no claim about the base',
  !/behind origin\/main|not taken from origin\/main/.test(native.stderr),
  JSON.stringify(native.stderr.slice(0, 200)),
)
// Both controls matter: a tripwire that fires everywhere would block the whole repository. The
// agent/* worktree sits at the SAME path shape as the refused one, so this also proves the check
// keys on provenance rather than on location.
const ours = guardFrom(join(primary, '.claude', 'worktrees', 'ours'), { hook: PROVISION_GUARD })
check('an agent/* worktree is allowed', ours.code === 0, `code=${ours.code} ${ours.stderr}`)
const prim = guardFrom(primary, { hook: PROVISION_GUARD })
check('primary checkout is allowed', prim.code === 0, `code=${prim.code} ${prim.stderr}`)

// THE GIT RULES, IN A WORKTREE THE SESSION HAS ENTERED. Each refusal is asserted by its reason. The
// control is the same command in the primary checkout, where the git rules do not apply: without
// it, a guard that refused every `git worktree` everywhere would pass these cases.
console.log('guard-git: the git rules in a worktree the session has entered')
const oursDir = join(primary, '.claude', 'worktrees', 'ours')
const WORKTREE_RULE = 'worktree management belongs to the orchestrator'
const why = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 200))}`

const primList = guardFrom(primary, { command: 'git worktree list' })
check('control: the primary checkout allows `git worktree list`', primList.code === 0, why(primList))
const listed = guardFrom(oursDir, { command: 'git worktree list' })
check(
  'the worktree refuses it, by its reason',
  listed.code === 2 && listed.stderr.includes(WORKTREE_RULE),
  why(listed),
)
mkdirSync(join(oursDir, 'sub'))
const pushed = guardFrom(join(oursDir, 'sub'), { command: 'git push origin main' })
check(
  'a subdirectory of it, after a cd, refuses a push to main, by its reason',
  pushed.code === 2 && pushed.stderr.includes('you cannot push to a long-lived branch'),
  why(pushed),
)
const byPayload = guardFrom(primary, { command: 'git worktree list', payloadDir: oursDir })
check(
  "the payload's cwd decides, not the process's directory",
  byPayload.code === 2 && byPayload.stderr.includes(WORKTREE_RULE),
  why(byPayload),
)
const noCwd = guardFrom(oursDir, { command: 'git worktree list', payloadDir: null })
check(
  "with no cwd in the payload, the process's directory decides",
  noCwd.code === 2 && noCwd.stderr.includes(WORKTREE_RULE),
  why(noCwd),
)

// A STRAY WORKTREE DIRECTORY: what a worktree removed under a live session
// leaves once the session writes a file there, a directory under `.claude/worktrees/<name>/` with no
// `.git` file, where git walks up to the primary checkout. Every git call there is refused by its
// reason, which names both paths, reads included. The controls are the same rebase in a registered
// worktree, where the briefing asks for it, and a command that is not git in the stray directory.
console.log('guard-git: git in a stray worktree directory')
const strayRoot = join(primary, '.claude', 'worktrees', 'gone')
mkdirSync(join(strayRoot, 'scripts'), { recursive: true })
writeFileSync(join(strayRoot, 'scripts', 'test-trace.mjs'), '// written after the removal\n')
const STRAY_RULE = `runs git in ${strayRoot}, but git there answers for ${realpathSync(primary)}`
const strayCases = [
  ['a rebase in it is refused', strayRoot, 'git rebase origin/main'],
  ['a read in a subdirectory of it is refused', join(strayRoot, 'scripts'), 'git status'],
  ['a fetch inside bash -c is refused', strayRoot, "bash -c 'git fetch origin'"],
]
for (const [label, dir, command] of strayCases) {
  const r = guardFrom(dir, { command })
  check(`${label}, by its reason`, r.code === 2 && r.stderr.includes(STRAY_RULE), why(r))
}
const oursRebase = guardFrom(oursDir, { command: 'git rebase origin/main' })
check('control: a registered worktree allows the rebase', oursRebase.code === 0, why(oursRebase))
const strayEcho = guardFrom(strayRoot, { command: 'ls scripts' })
check('control: a command that is not git is allowed there', strayEcho.code === 0, why(strayEcho))

/* --------------------------------------------------------------------------------------------- *
 * guard-git: an approval, and a merge past the checks, from any checkout.
 *
 * GitHub merges a pull request once `verify` passes and one approving review stands, which a
 * person gives, and `gh pr merge --admin` merges
 * past the checks with the maintainer's bypass, which is a person's. So the guard refuses
 * `gh pr review --approve` and `--admin` everywhere, and from a
 * worktree any merge but auto-merge. Each refusal is asserted by its reason. The controls are the
 * merge the primary checkout may make, auto-merge from a worktree in each spelling, a comment and a
 * request for changes, and the approval label, whose rule retired with the label: without them, a
 * guard that refused every `gh pr merge` or every `gh pr review`, or still every label, would pass.
 * The cases after these hold the parser: a flag before `pr create` once hid a missing `--base`, as
 * did gh's alias `pr new`, and a brace inside a word once split the statement, which hid the
 * endpoint of `repos/{owner}/{repo}/…`.
 * --------------------------------------------------------------------------------------------- */
console.log('guard-git: an approval, and a merge past the checks, from any checkout')
const POLICY_ROOT = resolve(HOOKS, '..', '..')

/** guard-git on `command` typed from `dir`. */
function ghGuard(dir, command) {
  const r = spawnSync('node', [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_input: { command } }),
    cwd: dir,
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: primary },
    encoding: 'utf8',
  })
  return { code: r.status ?? 1, stderr: r.stderr ?? '' }
}
const refusedFor = (r, reason) => r.code === 2 && r.stderr.includes(reason)
const ADMIN_RULE = "merges past the checks the trunk's ruleset requires"
const APPROVE_RULE = "an approval is a person's review of the change, never an agent's"
const MERGE_RULE = "a merge now is the orchestrator's call"

for (const [label, dir, command] of [
  ['a merge from the primary checkout', primary, 'gh pr merge 12 --rebase'],
  ['auto-merge from a worktree', oursDir, 'gh pr merge 12 --auto --rebase'],
  ['auto-merge spelt --auto=true, from a worktree', oursDir, 'gh pr merge 12 --auto=true --rebase'],
  ['auto-merge turned off from a worktree', oursDir, 'gh pr merge 12 --disable-auto'],
  ['the approval label, whose rule retired with it', oursDir, 'gh pr edit 12 --add-label review:approved'],
  ['a comment review, which approves nothing', oursDir, 'gh pr review 12 --comment -b "read it"'],
  ['a request for changes, which approves nothing', primary, 'gh pr review 12 --request-changes -b "no"'],
  ['--approve=false, which gh reads as no approval', oursDir, 'gh pr review 12 --approve=false --comment -b "read it"'],
  ['a comment whose body holds the letter, which is no flag', primary, 'gh pr review 12 --comment --body "a"'],
]) {
  const r = ghGuard(dir, command)
  check(`control: the guard allows ${label}`, r.code === 0, why(r))
}
for (const [label, dir, command] of [
  ['--admin, in the primary checkout', primary, 'gh pr merge 12 --admin --rebase'],
  ['--admin beside --auto, in a worktree', oursDir, 'gh pr merge 12 --auto --admin --rebase'],
  ['--admin=true after a flag before the group', primary, 'gh --repo o/r pr merge 12 --admin=true --rebase'],
  ['--admin inside bash -c', oursDir, 'bash -c "gh pr merge 12 --admin --rebase"'],
]) {
  const r = ghGuard(dir, command)
  check(`${label} is refused, by its reason`, refusedFor(r, ADMIN_RULE), why(r))
}
for (const [label, dir, command] of [
  ['an approval, in the primary checkout', primary, 'gh pr review 12 --approve'],
  ['an approval spelt -a, in a worktree', oursDir, 'gh pr review 12 -a -b "looks fine"'],
  ['--approve=true after a flag before the group', primary, 'gh --repo o/r pr review 12 --approve=true'],
  ['an approval inside bash -c', oursDir, 'bash -c "gh pr review 12 --approve"'],
  ['an approval after another statement', primary, 'git status; gh pr review 12 --approve'],
  ['an approval in a cluster of short flags, which gh reads as -a then -b', oursDir, 'gh pr review 12 -ab "looks fine"'],
  ['an approval spelt -a=true', primary, 'gh pr review 12 -a=true'],
]) {
  const r = ghGuard(dir, command)
  check(`${label} is refused, by its reason`, refusedFor(r, APPROVE_RULE), why(r))
}
for (const [label, command] of [
  ['a merge now, from a worktree', 'gh pr merge 12 --rebase'],
  ['auto-merge spelt --auto=false, from a worktree', 'gh pr merge 12 --auto=false --rebase'],
]) {
  const r = ghGuard(oursDir, command)
  check(`${label} is refused, by its reason`, refusedFor(r, MERGE_RULE), why(r))
}

const flagFirst = ghGuard(primary, 'gh --repo o/r pr create --fill')
check(
  'a flag before `pr create` no longer hides a missing --base, by its reason',
  refusedFor(flagFirst, 'a pull request must name `main` as its base'),
  why(flagFirst),
)
const flagFirstBase = ghGuard(primary, 'gh --repo o/r pr create --base main --fill')
check('control: the same with --base main is allowed', flagFirstBase.code === 0, why(flagFirstBase))
const aliased = ghGuard(primary, 'gh pr new --fill')
check(
  'gh pr new, the alias of create, with no --base is refused, by its reason',
  refusedFor(aliased, 'a pull request must name `main` as its base'),
  why(aliased),
)
// A brace inside a word is now a letter, so `{owner}` above keeps its endpoint; one standing as a
// word must still group commands, or the push inside this group would be read as the command `{`.
const grouped = ghGuard(oursDir, '{ git push origin main; }')
check(
  'a brace group still splits statements, so its push to main is refused, by its reason',
  refusedFor(grouped, 'you cannot push to a long-lived branch'),
  why(grouped),
)

// AN INHERITED GIT_DIR: one in the hook's environment outranks the payload's
// cwd, so the guard judged the checkout it named. Each case runs with it and, as its control,
// without any GIT_* key, and both must give the same verdict, by its reason: the unfixed guard
// refused the push from a subdirectory by the stray rule's reason, so asserting the refusal alone
// passed. The primary checkout's value is the one git exports to a hook run from that worktree.
console.log('guard-git: an inherited GIT_DIR does not move the checkout judged')
const PUSH_RULE = 'you cannot push to a long-lived branch'
const SHARED_GIT_DIR = { GIT_DIR: join(primary, '.git') }
const WORKTREE_GIT_DIR = { GIT_DIR: join(primary, '.git', 'worktrees', 'ours') }
for (const [label, dir, command, env, reason] of [
  ['a push to main from the worktree', oursDir, 'git push origin main', SHARED_GIT_DIR, PUSH_RULE],
  ['a push to main from a subdirectory of it', join(oursDir, 'sub'), 'git push origin main', SHARED_GIT_DIR, PUSH_RULE],
  ['a merge now from the worktree', oursDir, 'gh pr merge 1 --rebase', SHARED_GIT_DIR, MERGE_RULE],
  ['a push to main from the primary checkout', primary, 'git push origin main', WORKTREE_GIT_DIR, null],
]) {
  for (const [how, extra] of [['with GIT_DIR', env], ['control, with no GIT_* key', {}]]) {
    const r = guardFrom(dir, { command, env: extra })
    const verdict = reason === null ? 'allowed' : 'refused, by its reason'
    check(`${how}: ${label} is ${verdict}`, reason === null ? r.code === 0 : refusedFor(r, reason), why(r))
  }
}

// A BARE `git worktree prune`, EVERYWHERE: in a dev container a session works
// in the primary checkout, where the git rules are off, and a prune there takes every host worktree's
// record. Refused by its own reason from the primary checkout and from a worktree; the control is its
// dry run, which only reports.
console.log('guard-git: a bare git worktree prune, from any checkout')
const PRUNE_RULE = 'git worktree prune` takes every record git reads as stale'
for (const [label, dir, command, reason] of [
  ['git worktree prune, in the primary checkout', primary, 'git worktree prune', PRUNE_RULE],
  ['git worktree prune -v, in a worktree', oursDir, 'git worktree prune -v', PRUNE_RULE],
  // git honours the last of the pair, so a guard that looked for `--dry-run` anywhere let this prune.
  ['git worktree prune --dry-run --no-dry-run, in the primary checkout', primary, 'git worktree prune --dry-run --no-dry-run', PRUNE_RULE],
  ['control: git worktree prune --dry-run, in the primary checkout', primary, 'git worktree prune --dry-run', null],
  ['control: git worktree prune -n -v, in the primary checkout', primary, 'git worktree prune -n -v', null],
]) {
  const r = guardFrom(dir, { command })
  const verdict = reason === null ? 'allowed' : 'refused, by its reason'
  check(`${label} is ${verdict}`, reason === null ? r.code === 0 : refusedFor(r, reason), why(r))
}

// A MERGE INTO THE PRIMARY CHECKOUT, FROM ANY SESSION: a merge lands on the branch the checkout it
// runs in has checked out, so the guard follows `cd` and `git -C` there, and allows only a
// fast-forward of main. Each refusal is asserted by its reason. The controls are the briefing's own
// finish, in both spellings, a merge in the worktree itself and an abort: without them, a guard
// that refused every merge would pass.
console.log('guard-git: a merge into the primary checkout, from any session')
const PRIMARY_MERGE_RULE = 'is a fast-forward of `main`: `git -C'
const UNRESOLVED_RULE = 'cannot tell whether it lands in the primary checkout'
const mergeCases = () => [
  ["control: the briefing's finish, by git -C", oursDir, `git -C ${primary} merge --ff-only agent/ours`, null],
  ['control: the same after a cd, with -q', oursDir, `cd ${primary} && git merge --ff-only -q agent/ours`, null],
  ['control: a merge in the worktree itself', oursDir, 'git merge worktree-native', null],
  ['control: an abort in the primary checkout', oursDir, `git -C ${primary} merge --abort`, null],
  ['the Work run\'s merge, --no-ff after a cd', oursDir, `cd ${primary} && git merge --no-ff agent/ours -m x`, PRIMARY_MERGE_RULE],
  ['a merge with no --ff-only, by git -C', oursDir, `git -C ${primary} merge agent/ours`, PRIMARY_MERGE_RULE],
  ['--ff-only then an abbreviated --no-ff, which git honours', oursDir, `git -C ${primary} merge --ff-only --no-f agent/ours`, PRIMARY_MERGE_RULE],
  ['a relative -C that reaches it', oursDir, 'git -C ../../.. merge agent/ours', PRIMARY_MERGE_RULE],
  ['a cd and merge inside bash -c', oursDir, `bash -c "cd ${primary} && git merge agent/ours"`, PRIMARY_MERGE_RULE],
  ['a merge after an earlier cd moved the session there', primary, 'git merge --no-ff agent/ours', PRIMARY_MERGE_RULE],
  ['a cd through a variable, from a worktree', oursDir, 'cd "$P" && git merge --ff-only agent/ours', UNRESOLVED_RULE],
  ['--abort beside a merge, which no longer exempts it', oursDir, `git -C ${primary} merge --abort --no-ff agent/ours`, PRIMARY_MERGE_RULE],
]
for (const [label, dir, command, reason] of mergeCases()) {
  const r = guardFrom(dir, { command })
  const verdict = reason === null ? 'allowed' : 'refused, by its reason'
  check(`${label} is ${verdict}`, reason === null ? r.code === 0 : refusedFor(r, reason), why(r))
}
// The briefing's finish itself is refused while the primary checkout has another branch checked out.
git(primary, 'switch', '-q', '-c', 'side')
const sideMerge = guardFrom(oursDir, { command: `git -C ${primary} merge --ff-only agent/ours` })
git(primary, 'switch', '-q', 'main')
check(
  'a fast-forward into a primary checkout on another branch is refused, naming it',
  refusedFor(sideMerge, 'It has `side` checked out, not `main`'),
  why(sideMerge),
)

/* --------------------------------------------------------------------------------------------- *
 * guard-git: graphify's eroding commands, from any checkout.
 *
 * graphify's `update`, `watch` and `hook install` rebuild the local code graph through the path that
 * erodes its document layer, and `claude install` writes graphify's advice to run `update` into
 * CLAUDE.md, so the guard refuses each, in the primary checkout as in a
 * worktree. Each refusal is asserted by its reason, which names the command and leaves the
 * graph to a person, and the module cases hold each way Python reads `-m`. The controls are graphify's
 * reading commands, which must still run, and the near misses: a command that shares a first word
 * with a refused one, a refused word as another command's argument or as graphify's second, and a
 * refused command asking for help, which graphify answers with a line of help alone. Without them, a
 * guard that refused every graphify command, matched the first word alone, matched the words
 * anywhere in the line or among graphify's arguments, or refused a request for help would pass.
 * --------------------------------------------------------------------------------------------- */
console.log("guard-git: graphify's eroding commands, from any checkout")
const graphifyRefusal = (words) => (r) =>
  r.code === 2 &&
  r.stderr.includes(`\`graphify ${words}\``) &&
  r.stderr.includes('A person builds and refreshes the graph')
for (const [label, dir, words, command] of [
  ['graphify update, in the primary checkout', primary, 'update', 'graphify update .'],
  ['graphify watch, in a worktree', oursDir, 'watch', 'graphify watch .'],
  ['graphify hook install, in the primary checkout', primary, 'hook install', 'graphify hook install'],
  ['graphify claude install, in a worktree', oursDir, 'claude install', 'graphify claude install'],
  [
    'graphify update by path, after an environment assignment',
    primary,
    'update',
    'GRAPHIFY_FORCE=1 ~/.local/bin/graphify update . --force',
  ],
  ['graphify run as a Python module', primary, 'update', 'python3 -u -m graphify update .'],
  ['graphify as a module past an option with a value', primary, 'update', 'python3 -X dev -m graphify update .'],
  ['graphify as a module in a group of flags', oursDir, 'watch', 'python3 -um graphify watch .'],
  ['graphify as a module named in the flag', primary, 'hook install', 'python3 -mgraphify hook install'],
  ["graphify's __main__ run as a module", primary, 'claude install', 'python3 -m graphify.__main__ claude install'],
  ['graphify watch inside bash -c', primary, 'watch', "bash -c 'graphify watch .'"],
  ['graphify hook install after another statement', oursDir, 'hook install', 'git status; graphify hook install'],
]) {
  const r = ghGuard(dir, command)
  check(`${label} is refused, by its reason`, graphifyRefusal(words)(r), why(r))
}
for (const [label, command] of [
  ['graphify query', 'graphify query "what calls guard-git"'],
  ['graphify path', 'graphify path "guard-git.mjs" "policy.ts"'],
  ['graphify explain', 'graphify explain "guard-git.mjs"'],
  ['graphify extract', 'graphify extract . --code-only'],
  ['graphify hook status, which shares its first word with hook install', 'graphify hook status'],
  ['graphify claude uninstall, which shares its first word with claude install', 'graphify claude uninstall'],
  ["graphify update's words as another command's argument", 'echo graphify update'],
  ["a refused command's word as graphify's second argument", 'graphify explain update'],
  ['graphify update --help, which graphify answers with help alone', 'graphify update --help'],
  ['graphify query run as a Python module', 'python3 -m graphify query "what calls guard-git"'],
]) {
  const r = ghGuard(primary, command)
  check(`control: the primary checkout allows ${label}`, r.code === 0, why(r))
}

/* --------------------------------------------------------------------------------------------- *
 * A worktree record this checkout cannot see.
 *
 * git cannot tell a worktree that was removed from one whose path it cannot see: both read as
 * `prunable`, and `git worktree prune` deletes both records. In a container on a bind-mounted clone,
 * every record of a worktree made on the host names a host path, so every one is the second kind. On
 * 2026-10-06 a push from such a container ran this selftest, whose foreign-path cases above made the
 * remove hook run `git worktree prune` on the real repository, and every linked worktree on the host
 * lost its record. In a scratch repository of its own, `unseen` has that shape, its parent directory
 * gone with it; `removed` was deleted from inside `.claude/worktrees/`, whose parent stays; `lane` is
 * live. Given a path it does not own, the remove hook touches no record: not `lane`'s, which shares
 * the foreign path's last name and so was deleted as its admin directory, and no stale one, which its
 * own prune took.
 * --------------------------------------------------------------------------------------------- */
console.log('a worktree record this checkout cannot see')
const unseenRepo = mkdtempSync(join(tmpdir(), 'wt-unseen-'))
const unseenPrimary = join(unseenRepo, 'primary')
execFileSync('git', ['init', '-q', '-b', 'main', unseenPrimary], { env: GIT_ENV, encoding: 'utf8' })
git(unseenPrimary, ...AS, 'commit', '-q', '--allow-empty', '-m', 'base')
git(unseenPrimary, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
const unseenWt = (path, name) =>
  git(unseenPrimary, 'worktree', 'add', '-q', '-b', `agent/${name}`, path, 'main')
unseenWt(join(unseenPrimary, '.claude', 'worktrees', 'lane'), 'lane')
unseenWt(join(unseenPrimary, '.claude', 'worktrees', 'removed'), 'removed')
const hostSide = join(unseenRepo, 'host')
unseenWt(join(hostSide, 'worktrees', 'unseen'), 'unseen')
rmSync(join(unseenPrimary, '.claude', 'worktrees', 'removed'), { recursive: true, force: true })
rmSync(hostSide, { recursive: true, force: true })
const unseenRegistered = (name) => existsSync(join(unseenPrimary, '.git', 'worktrees', name))

// The hook works on the checkout it sits in, so a copy sits in the scratch one, run with no GIT_* key:
// an inherited GIT_DIR, which the hook runner drops but another caller may not, would point its git
// at this repository.
const unseenHook = join(unseenPrimary, 'scripts', 'hooks', 'worktree-remove.mjs')
mkdirSync(dirname(unseenHook), { recursive: true })
copyFileSync(REMOVE, unseenHook)
const foreign = join(unseenRepo, 'foreign', 'lane')
mkdirSync(foreign, { recursive: true })
const foreignRun = spawnSync('node', [unseenHook], {
  input: JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: foreign }),
  env: GIT_ENV,
  encoding: 'utf8',
})
check('the hook removes a foreign directory', foreignRun.status === 0 && !existsSync(foreign), foreignRun.stderr)
check("a live worktree sharing the foreign path's last name keeps its record", unseenRegistered('lane'))
check('a record this checkout cannot see keeps it', unseenRegistered('unseen'))
check('a removed worktree keeps it too: the hook prunes nothing', unseenRegistered('removed'))
// The fallback's own admin directory, for a path the hook owns. git names one after the worktree's
// last path segment and adds a number on a collision, so `.git/worktrees/<basename>` can be another
// worktree's. `elsewhere/lane` is registered first, as `lane`; the owned `lane` second, as `lane1`,
// and locked, so `git worktree remove --force` refuses it, as the sandbox does, and the fallback runs.
const twinPrimary = join(realpathSync(mkdtempSync(join(tmpdir(), 'wt-twin-'))), 'primary')
execFileSync('git', ['init', '-q', '-b', 'main', twinPrimary], { env: GIT_ENV, encoding: 'utf8' })
git(twinPrimary, ...AS, 'commit', '-q', '--allow-empty', '-m', 'base')
git(twinPrimary, 'worktree', 'add', '-q', '-b', 'agent/elsewhere-lane', join(dirname(twinPrimary), 'elsewhere', 'lane'), 'main')
const ownedLane = join(twinPrimary, '.claude', 'worktrees', 'lane')
git(twinPrimary, 'worktree', 'add', '-q', '-b', 'agent/lane', ownedLane, 'main')
git(twinPrimary, 'worktree', 'lock', ownedLane)
const twinHook = join(twinPrimary, 'scripts', 'hooks', 'worktree-remove.mjs')
mkdirSync(dirname(twinHook), { recursive: true })
copyFileSync(REMOVE, twinHook)
const ownedRun = spawnSync('node', [twinHook], {
  input: JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: ownedLane }),
  env: GIT_ENV,
  encoding: 'utf8',
})
const twinRecord = (id) => existsSync(join(twinPrimary, '.git', 'worktrees', id))
check(
  'the fallback removes an owned worktree and its own record',
  ownedRun.stderr.includes('removing directly') && !existsSync(ownedLane) && !twinRecord('lane1'),
  ownedRun.stderr,
)
check('and keeps the record of the worktree whose name its own collided with', twinRecord('lane'))
// Its `.git` file is the worktree's to write, so it is not trusted alone: one rewritten to name
// another worktree's admin directory must not get that record deleted. The fallback takes only an
// admin directory whose own `gitdir` names this worktree back, the link git itself keeps.
const forged = join(twinPrimary, '.claude', 'worktrees', 'forged')
git(twinPrimary, 'worktree', 'add', '-q', '-b', 'agent/forged', forged, 'main')
git(twinPrimary, 'worktree', 'lock', forged)
writeFileSync(join(forged, '.git'), `gitdir: ${join(twinPrimary, '.git', 'worktrees', 'lane')}\n`)
const forgedRun = spawnSync('node', [twinHook], {
  input: JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: forged }),
  env: GIT_ENV,
  encoding: 'utf8',
})
check(
  "a worktree whose .git file names another's admin directory leaves that record alone",
  forgedRun.stderr.includes('removing directly') && !existsSync(forged) && twinRecord('lane'),
  forgedRun.stderr,
)
// The image's half: `git gc` prunes a stale record once its index is older than
// gc.worktreePruneExpire, so in the container it would take an old host worktree's. No selftest
// builds the image, so this reads the Dockerfile's text; the trunk's before this case had no such line.
check(
  "the dev container's image sets gc.worktreePruneExpire to never",
  /^\s*(?:RUN|&&) git config --system gc\.worktreePruneExpire never\s*$/m.test(
    readFileSync(join(POLICY_ROOT, '.devcontainer', 'Dockerfile'), 'utf8'),
  ),
)

/* --------------------------------------------------------------------------------------------- *
 * render-worktree-context: the briefing a new worktree opens with.
 *
 * THE GAP. This suite is the template's and the renderer's selftest, and until 2026-09-25 no case
 * here read either, so a change to the template ran a selftest that passed without looking at it.
 * Two template changes were proved by a render run by hand into `.scratch/` instead: one on
 * 2026-09-23, and the port paragraphs on 2026-09-24.
 *
 * The renderer and the committed template are COPIED into a scratch checkout, because the renderer
 * finds the template beside itself and has no root override: run in place, a write relative to its own
 * checkout would land in this one. The copy runs from an empty directory, and every file under the
 * scratch root is listed afterwards, so a write anywhere but the path it was handed shows. The values
 * are hostile on purpose: `&` and `\` are what `sed` mangled (the renderer's header records `a&b`
 * rendering as `a{{WORKTREE_PATH}}b`), and `$&`, `$$` and `$1` are what `String.replace` expands when
 * it is handed a replacement string rather than a function.
 *
 * The control is the committed template, which must render clean. The negative is the same template
 * with a placeholder the renderer does not supply, which must be refused by its reason with nothing
 * written: without it, a renderer that lost its leftover check would still pass the control.
 * --------------------------------------------------------------------------------------------- */
console.log('render-worktree-context: the briefing template, rendered')
const RENDERER = resolve(HOOKS, '..', 'render-worktree-context.mjs')
const TEMPLATE_TEXT = readFileSync(
  resolve(HOOKS, '..', '..', '.harness', 'worktree-CONTEXT.md.tmpl'),
  'utf8',
)
const HOSTILE = { BRANCH: 'agent/b&r\\$&', BASE_SHA: 's&h\\$$a', TASK_REF: 't&sk\\$&$1' }
const ADAPTER_FILES = ['adapters.mjs', 'claude.mjs', 'codex.mjs', 'copilot.mjs', 'formats.mjs', 'opencode.mjs']
function copyAdapters(checkout) {
  const destination = join(checkout, 'tools', 'integrations')
  mkdirSync(destination, { recursive: true })
  for (const file of ADAPTER_FILES) {
    copyFileSync(resolve(HOOKS, '../../tools/integrations', file), join(destination, file))
  }
}
const COPIED = [
  ...ADAPTER_FILES.map((file) => join('checkout', 'tools', 'integrations', file)),
  join('checkout', '.harness', 'worktree-CONTEXT.md.tmpl'),
  join('checkout', 'scripts', 'render-worktree-context.mjs'),
].sort()

/**
 * Render `template` through a copy of the renderer in a fresh scratch checkout, with the arguments
 * `scripts/new-worktree.sh` passes, into a worktree directory named `a&b`. Returns the run, the
 * worktree path it was handed, and every file under the scratch root afterwards, relative to it.
 */
function render(template) {
  const root = mkdtempSync(join(tmpdir(), 'wt-render-'))
  const copy = join(root, 'checkout', 'scripts', 'render-worktree-context.mjs')
  mkdirSync(dirname(copy), { recursive: true })
  mkdirSync(join(root, 'checkout', '.harness'))
  copyAdapters(join(root, 'checkout'))
  copyFileSync(RENDERER, copy)
  writeFileSync(join(root, 'checkout', '.harness', 'worktree-CONTEXT.md.tmpl'), template)
  const worktree = join(root, 'a&b')
  mkdirSync(worktree)
  mkdirSync(join(root, 'cwd'))
  // GIT_ENV, because the renderer runs `git worktree list` to spare its siblings' ports, and an
  // inherited GIT_DIR, which the hook runner drops but another caller may not, would point that at
  // this repository.
  const r = spawnSync('node', [copy, worktree, HOSTILE.BRANCH, HOSTILE.BASE_SHA, HOSTILE.TASK_REF], {
    cwd: join(root, 'cwd'),
    env: GIT_ENV,
    encoding: 'utf8',
  })
  const files = readdirSync(root, { recursive: true })
    .filter((p) => statSync(join(root, p)).isFile())
    .sort()
  // The renderer's own path, as Node resolves it, so a symlinked temporary directory still matches.
  const checkout = realpathSync(join(root, 'checkout'))
  return { code: r.status ?? 1, stderr: r.stderr ?? '', worktree, checkout, files }
}

const rendered = render(TEMPLATE_TEXT)
check(
  'the committed template renders',
  rendered.code === 0,
  `code=${rendered.code} ${rendered.stderr}`,
)
const contextFile = join(rendered.worktree, '.worktree', 'CONTEXT.md')
const context = existsSync(contextFile) ? readFileSync(contextFile, 'utf8') : ''
// Broader than the renderer's own `{{[A-Z_]+}}`, so a mistyped `{{app_port}}` is caught here too.
const survivors = context.match(/\{\{[^}]*\}\}/g) ?? []
check(
  'no {{PLACEHOLDER}} survives',
  context !== '' && survivors.length === 0,
  survivors.join(', '),
)
// Each value appears exactly as often as its placeholder does in the template. A mangled value is
// missing from the count; one that `$&` expanded also leaves its placeholder for the check above.
let exercised = 0
// The scratch checkout is no git repository, so PRIMARY_CHECKOUT takes the renderer's fallback.
const renderedValues = {
  WORKTREE_PATH: rendered.worktree,
  PRIMARY_CHECKOUT: rendered.checkout,
  ...HOSTILE,
}
for (const [key, value] of Object.entries(renderedValues)) {
  const want = TEMPLATE_TEXT.split(`{{${key}}}`).length - 1
  if (want === 0) continue
  exercised += 1
  const got = context.split(value).length - 1
  check(
    `${key} renders ${JSON.stringify(value)} literally`,
    got === want,
    `${got} of ${want} occurrence(s)`,
  )
}
check('the template carries a placeholder the hostile values reach', exercised > 0)
const WRITTEN = [join('a&b', '.worktree', 'CONTEXT.md'), join('a&b', '.worktree', 'ports.env')]
check(
  'CONTEXT.md and ports.env are written under the path given, and nothing else is',
  JSON.stringify(rendered.files) === JSON.stringify([...COPIED, ...WRITTEN].sort()),
  JSON.stringify(rendered.files),
)
// The banner once said the file was read by a `vite.config.ts` this repository never had.
// It must name its reader, every file it names must exist here, and the pair
// must be in the one form that reader parses, or the next worktree is handed the same ports.
const portsFile = join(rendered.worktree, '.worktree', 'ports.env')
const portsText = existsSync(portsFile) ? readFileSync(portsFile, 'utf8') : ''
const banner = portsText.split('\n').filter((line) => line.startsWith('#'))
const named = banner.join('\n').match(/[\w./-]+\.(?:mjs|js|ts|md|json|sh)\b/g) ?? []
const missing = named.filter((path) => !existsSync(resolve(HOOKS, '..', '..', path)))
check(
  'ports.env names its reader, and every file it names exists',
  named.includes('scripts/render-worktree-context.mjs') && missing.length === 0,
  `named ${JSON.stringify(named)}, missing ${JSON.stringify(missing)}`,
)
check(
  'and it holds the pair in the form that reader parses',
  JSON.stringify([...portsText.matchAll(/^([A-Z_]+)=\d+$/gm)].map((m) => m[1])) ===
    JSON.stringify(['APP_PORT', 'SB_PORT']),
  JSON.stringify(portsText),
)

const refused = render(`${TEMPLATE_TEXT}\n{{DB_NAME}}\n`)
check(
  'a placeholder the renderer does not supply is refused, by its reason',
  refused.code === 1 &&
    refused.stderr.includes('unsubstituted placeholders in the rendered context: {{DB_NAME}}'),
  `code=${refused.code} ${JSON.stringify(refused.stderr.slice(0, 200))}`,
)
check(
  'and nothing is written',
  JSON.stringify(refused.files) === JSON.stringify(COPIED),
  JSON.stringify(refused.files),
)

/* --------------------------------------------------------------------------------------------- *
 * new-worktree.sh: the briefing is the base's template, not the checkout's.
 *
 * THE INCIDENT. The script ran the primary checkout's renderer, which reads the
 * template beside itself, so a worktree cut from `origin/main` opened with whatever template the
 * checkout's working tree held. On 2026-09-23 and again on 2026-09-25 that was an older one, and the
 * briefing, which `AGENTS.md` gives precedence, carried steps the base had already replaced. The
 * render case above could not see it: it copies one template beside the renderer, so there is no
 * second template to read by mistake.
 *
 * So this case builds a scratch repository whose checkout trails its remote by one commit, a commit
 * that changes only the template, and runs the checkout's copy of the script from the checkout, as
 * the WorktreeCreate hook runs it. The briefing must be the base's template, rendered, word for word.
 * The negative is the same script doctored back to the checkout's renderer, which must render the
 * checkout's template: without it, a scratch repository whose two templates never differed would
 * pass the case.
 * --------------------------------------------------------------------------------------------- */
console.log("new-worktree: the briefing is the base's template, not the checkout's")
const PROVISION = resolve(HOOKS, '..', 'new-worktree.sh')
const trailing = mkdtempSync(join(tmpdir(), 'wt-base-'))
const trailingPrimary = join(trailing, 'primary')
const trailingOrigin = join(trailing, 'origin.git')
const templateOf = (where) =>
  `rendered from the ${where}: {{BRANCH}} cut at {{BASE_SHA}} for {{TASK_REF}}\n`

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', trailingOrigin], { env: GIT_ENV })
execFileSync('git', ['init', '-q', '-b', 'main', trailingPrimary], { env: GIT_ENV })
mkdirSync(join(trailingPrimary, 'scripts'))
mkdirSync(join(trailingPrimary, '.harness'))
copyAdapters(trailingPrimary)
copyFileSync(PROVISION, join(trailingPrimary, 'scripts', 'new-worktree.sh'))
copyFileSync(RENDERER, join(trailingPrimary, 'scripts', 'render-worktree-context.mjs'))
const trailingTemplate = join(trailingPrimary, '.harness', 'worktree-CONTEXT.md.tmpl')
writeFileSync(trailingTemplate, templateOf('checkout'))
git(trailingPrimary, 'add', '.')
git(trailingPrimary, ...AS, 'commit', '-qm', 'the template the checkout keeps')
writeFileSync(trailingTemplate, templateOf('base'))
git(trailingPrimary, ...AS, 'commit', '-qam', 'the template the base moves on to')
git(trailingPrimary, 'remote', 'add', 'origin', trailingOrigin)
git(trailingPrimary, 'push', '-q', 'origin', 'main')
// The checkout falls one commit behind the remote, as a primary checkout nobody has pulled does.
git(trailingPrimary, 'reset', '-q', '--hard', 'HEAD~1')

/**
 * Provision `name` by running `script` with bash from a scratch checkout, `primary` (the trailing
 * one unless named), as the WorktreeCreate hook runs it, and return the run with the worktree's path
 * and the briefing it wrote. The variables the script reads are pinned, so a developer's own
 * `WORKTREE_ROOT` or `TRUNK_BRANCH` cannot move the case.
 */
function provision(script, name, primary = trailingPrimary) {
  const worktrees = join(primary, '.claude', 'worktrees')
  const r = spawnSync('bash', [script, name], {
    cwd: primary,
    env: { ...GIT_ENV, WORKTREE_ROOT: worktrees, TRUNK_BRANCH: 'main', LIFETIME_HOURS: '2' },
    encoding: 'utf8',
  })
  const briefing = join(worktrees, name, '.worktree', 'CONTEXT.md')
  return {
    code: r.status ?? 1,
    stderr: r.stderr ?? '',
    path: join(worktrees, name),
    text: existsSync(briefing) ? readFileSync(briefing, 'utf8') : '',
  }
}
/** The template `where` holds, rendered with the values the script passes for `name`. */
function expected(where, name) {
  const base = git(trailingPrimary, 'rev-parse', '--short', 'origin/main').trim()
  const values = { BRANCH: `agent/${name}`, BASE_SHA: base, TASK_REF: name }
  return templateOf(where).replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key])
}

const fromBase = provision(join(trailingPrimary, 'scripts', 'new-worktree.sh'), 'fresh')
check(
  'a checkout trailing its base provisions a worktree',
  fromBase.code === 0,
  `code=${fromBase.code} ${JSON.stringify(fromBase.stderr.slice(0, 300))}`,
)
check(
  "its briefing is the base's template, rendered",
  fromBase.text === expected('base', 'fresh'),
  JSON.stringify(fromBase.text),
)

const RUNS_ITS_OWN = 'node "$WORKTREE_PATH/scripts/render-worktree-context.mjs"'
const doctoredScript = join(trailing, 'new-worktree.doctored.sh')
const provisionSource = readFileSync(PROVISION, 'utf8')
writeFileSync(
  doctoredScript,
  provisionSource.replace(RUNS_ITS_OWN, 'node "$REPO_ROOT/scripts/render-worktree-context.mjs"'),
)
check(
  "negative: the doctoring reaches the script's renderer line",
  provisionSource.includes(RUNS_ITS_OWN),
  `no ${RUNS_ITS_OWN} in scripts/new-worktree.sh`,
)
const fromCheckout = provision(doctoredScript, 'doctored')
check(
  "doctored to run the checkout's renderer, it renders the checkout's template",
  fromCheckout.code === 0 && fromCheckout.text === expected('checkout', 'doctored'),
  `code=${fromCheckout.code} ${JSON.stringify(fromCheckout.text || fromCheckout.stderr.slice(0, 300))}`,
)

/* --------------------------------------------------------------------------------------------- *
 * new-worktree.sh: concurrent runs, and the branch a failed run made.
 *
 * THE INCIDENT. On 2026-09-26 a fan-out sweep launched eleven lanes in one
 * message, and two WorktreeCreate hooks failed with "could not lock config file .git/config: File
 * exists": `git worktree add -b ... origin/main` set the new branch's upstream, a write to the
 * shared `.git/config` that concurrent runs race for, and the cleanup trap acted only once the
 * worktree existed, so each failure left its branch behind with no worktree. A `.git/config.lock`
 * the case holds stands in for the concurrent run that holds it, which makes the race certain.
 *
 * So, with the lock held, the script must provision and write no tracking config. The negative is
 * the script doctored back to that one `git worktree add -b`, which must fail by the lock's reason
 * and leave its branch: without it, a git that set up no upstream would pass the case unraced. A run
 * that fails after making its branch, at an occupied worktree path, must delete that branch, by its
 * reason, and leave the directory as it found it. The control is a name whose branch already exists,
 * which must fail and keep that branch, which the run did not make: without it, a trap that deleted
 * whatever branch the name gave would pass the case above.
 * --------------------------------------------------------------------------------------------- */
console.log('new-worktree: concurrent runs, and the branch a failed run made')
const race = mkdtempSync(join(tmpdir(), 'wt-race-'))
const racePrimary = join(race, 'primary')
const raceOrigin = join(race, 'origin.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', raceOrigin], { env: GIT_ENV })
execFileSync('git', ['init', '-q', '-b', 'main', racePrimary], { env: GIT_ENV })
mkdirSync(join(racePrimary, 'scripts'))
mkdirSync(join(racePrimary, '.harness'))
copyAdapters(racePrimary)
copyFileSync(PROVISION, join(racePrimary, 'scripts', 'new-worktree.sh'))
copyFileSync(RENDERER, join(racePrimary, 'scripts', 'render-worktree-context.mjs'))
writeFileSync(join(racePrimary, '.harness', 'worktree-CONTEXT.md.tmpl'), templateOf('base'))
git(racePrimary, 'add', '.')
git(racePrimary, ...AS, 'commit', '-qm', 'a checkout lanes are cut from')
git(racePrimary, 'remote', 'add', 'origin', raceOrigin)
git(racePrimary, 'push', '-q', 'origin', 'main')
const raceScript = join(racePrimary, 'scripts', 'new-worktree.sh')
/** The tip of `agent/<name>` in the scratch checkout, or null when it has no such branch. */
const raceTip = (name) => {
  try {
    return git(racePrimary, 'rev-parse', '--verify', '--quiet', `refs/heads/agent/${name}`).trim()
  } catch {
    return null
  }
}
/** The `branch.agent/<name>.*` keys in the scratch checkout's own config. */
const trackingKeys = (name) =>
  git(racePrimary, 'config', '--local', '--name-only', '--list')
    .split('\n')
    .filter((key) => key.startsWith(`branch.agent/${name}.`))
const raceWhy = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 400))}`

const configLock = join(racePrimary, '.git', 'config.lock')
writeFileSync(configLock, '')
const held = provision(raceScript, 'held', racePrimary)
check(
  'with .git/config.lock held, as a concurrent run holds it, the script provisions a worktree',
  held.code === 0 && held.text !== '',
  raceWhy(held),
)
check('and writes no tracking config', trackingKeys('held').length === 0, JSON.stringify(trackingKeys('held')))

const CUTS_BRANCH = 'git -C "$REPO_ROOT" branch --no-track "$BRANCH" "origin/$TRUNK"'
const ADDS_WORKTREE = 'git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"'
check(
  "negative: the doctoring reaches the script's branch and worktree lines",
  provisionSource.includes(CUTS_BRANCH) && provisionSource.includes(ADDS_WORKTREE),
  `no ${CUTS_BRANCH} or no ${ADDS_WORKTREE} in scripts/new-worktree.sh`,
)
const oneStepScript = join(race, 'new-worktree.one-step.sh')
writeFileSync(
  oneStepScript,
  provisionSource
    .replace(CUTS_BRANCH, 'git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH" "origin/$TRUNK"')
    .replace(ADDS_WORKTREE, ':'),
)
const oneStep = provision(oneStepScript, 'one-step', racePrimary)
check(
  'doctored back to one `git worktree add -b`, it fails by the lock and leaves its branch behind',
  oneStep.code !== 0 &&
    oneStep.stderr.includes('could not lock config file') &&
    raceTip('one-step') !== null &&
    !existsSync(oneStep.path),
  `${raceWhy(oneStep)} branch=${raceTip('one-step')}`,
)
rmSync(configLock, { force: true })

const occupied = join(racePrimary, '.claude', 'worktrees', 'occupied')
mkdirSync(occupied, { recursive: true })
const OCCUPANT = 'a file the run did not write\n'
writeFileSync(join(occupied, 'occupant.txt'), OCCUPANT)
const blocked = provision(raceScript, 'occupied', racePrimary)
check(
  'a run that fails after making its branch deletes that branch, by its reason',
  blocked.code !== 0 &&
    blocked.stderr.includes('already exists') &&
    blocked.stderr.includes('deleting agent/occupied, the branch this run made') &&
    raceTip('occupied') === null,
  `${raceWhy(blocked)} branch=${raceTip('occupied')}`,
)
check(
  'and leaves the directory it found as it found it',
  existsSync(join(occupied, 'occupant.txt')) &&
    readFileSync(join(occupied, 'occupant.txt'), 'utf8') === OCCUPANT &&
    JSON.stringify(readdirSync(occupied)) === JSON.stringify(['occupant.txt']),
  JSON.stringify(existsSync(occupied) ? readdirSync(occupied) : null),
)

git(racePrimary, 'branch', '--no-track', 'agent/taken', 'main')
const takenTip = raceTip('taken')
const taken = provision(raceScript, 'taken', racePrimary)
check(
  'control: a run whose branch already exists fails, and keeps that branch, which it did not make',
  taken.code !== 0 &&
    taken.stderr.includes("a branch named 'agent/taken' already exists") &&
    raceTip('taken') === takenTip &&
    !existsSync(taken.path),
  `${raceWhy(taken)} branch=${raceTip('taken')}`,
)

/* --------------------------------------------------------------------------------------------- *
 * .claude/settings.json: every registered hook loads whatever the working directory is.
 *
 * THE INCIDENT. Every hook was registered as `node scripts/hooks/<name>.mjs`,
 * a path relative to the directory the harness runs a hook in, which is the session's current one.
 * On 2026-09-25, after a Bash `cd docs`, the Stop hook failed with "Cannot find module
 * .../docs/scripts/hooks/gate-summary.mjs" and printed no verdict, and `guard-git.mjs` failed to
 * load the same way; its exit 1 does not block, so the next command ran unguarded. Each command now
 * names its script through `$CLAUDE_PROJECT_DIR`.
 *
 * Each registered command runs as the harness runs a command hook, through `sh -c` with
 * `CLAUDE_PROJECT_DIR` naming this checkout, from a subdirectory of it (the incident's shape) and
 * from a directory outside it. The `node` first on PATH is a stand-in that reports the script it was
 * handed and runs nothing, because `worktree-create.mjs` provisions a real worktree when it runs. So
 * every command must be `node <script>`: that is what lets this case test one without running it.
 *
 * The control is the old relative form from the checkout root, which must load; the negative is the
 * same form from the subdirectory, which must be refused for that reason. Without the pair, a
 * stand-in that refused everything, or loaded everything, would pass every case below it.
 * --------------------------------------------------------------------------------------------- */
console.log('settings: every registered hook loads whatever the working directory')
const CHECKOUT = resolve(HOOKS, '..', '..')
const settings = JSON.parse(renderIntegrations({ root: CHECKOUT }).files.get('.claude/settings.json'))
const hookCommands = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
  groups.flatMap((group) =>
    (group.hooks ?? [])
      .filter((hook) => hook.type === 'command')
      .map((hook) => ({ event, command: hook.command })),
  ),
)

const stubBin = mkdtempSync(join(tmpdir(), 'hook-node-'))
writeFileSync(
  join(stubBin, 'node'),
  [
    '#!/bin/sh',
    '# Stands in for node: reports the script it was handed, and runs nothing.',
    'if [ -f "$1" ]; then printf "loads %s\\n" "$1"; exit 0; fi',
    'printf "no such script: %s\\n" "$1" >&2',
    'exit 3',
    '',
  ].join('\n'),
  { mode: 0o755 },
)
const subdir = join(CHECKOUT, 'scripts')
const outside = mkdtempSync(join(tmpdir(), 'hook-cwd-'))

/** Run one hook command as the harness would, from `cwd`, with the stand-in `node` first on PATH. */
function loadFrom(command, cwd) {
  const r = spawnSync('sh', ['-c', command], {
    cwd,
    env: {
      ...process.env,
      PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_PROJECT_DIR: CHECKOUT,
    },
    encoding: 'utf8',
  })
  return { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

const RELATIVE = 'node scripts/hooks/guard-git.mjs'
const fromRoot = loadFrom(RELATIVE, CHECKOUT)
check(
  'control: the relative form loads from the checkout root',
  fromRoot.code === 0 && fromRoot.stdout === 'loads scripts/hooks/guard-git.mjs',
  `code=${fromRoot.code} ${fromRoot.stdout} ${fromRoot.stderr}`,
)
const fromSubdir = loadFrom(RELATIVE, subdir)
check(
  'the relative form is refused from a subdirectory, by its reason',
  fromSubdir.code === 3 && fromSubdir.stderr === 'no such script: scripts/hooks/guard-git.mjs',
  `code=${fromSubdir.code} ${fromSubdir.stdout} ${fromSubdir.stderr}`,
)

check('settings.json registers a command hook', hookCommands.length > 0)
const HOOK_DIR = `${join(CHECKOUT, 'scripts', 'hooks')}${sep}`
for (const { event, command } of hookCommands) {
  if (!/^node\s/.test(command)) {
    check(`${event}: ${command} is a node command`, false, 'nothing else can be tested unrun')
    continue
  }
  for (const [where, cwd] of [
    ['a subdirectory', subdir],
    ['outside the checkout', outside],
  ]) {
    const r = loadFrom(command, cwd)
    check(
      `${event}: ${command} loads from ${where}`,
      r.code === 0 && r.stdout.startsWith(`loads ${HOOK_DIR}`),
      `code=${r.code} ${r.stdout} ${r.stderr}`,
    )
  }
}

console.log(failures === 0 ? '\nall worktree hook checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Self-test for scripts/hooks/guard-git.mjs, scripts/hooks/guard-unprovisioned-worktree.mjs,
 * scripts/setup-worktree.mjs, scripts/render-worktree-context.mjs with the briefing template it
 * renders, scripts/new-worktree.sh's choice of which copy of that template renders, its run beside
 * another that holds `.git/config.lock`, the branch a failed run of it made, the lock it adds a
 * worktree with and the commit identity set there, and for the hook registrations in
 * the rendered Claude settings: each must load
 * whatever the session's working directory is (the last section says what broke).
 *
 * Every case that needs a worktree makes one in a scratch repository of its own under the temporary
 * directory: `git worktree add` against THIS repository is refused to a worktree-isolated session by
 * scripts/hooks/guard-git.mjs, and a selftest must not register a worktree in the repository it
 * runs from.
 *
 *   node scripts/hooks/worktree-hooks.selftest.mjs
 *
 * Needs `git`, `bash` and a POSIX `sh` on PATH. It reads nothing outside the temporary directory
 * but this checkout's own files. The render, setup and new-worktree cases bind loopback ports for a
 * moment, as the renderer's port probe does.
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
import { activeIntegration, renderCliText } from '../../tools/integrations/adapters.mjs'
import { renderIntegrations } from '../../tools/integrations/render.mjs'

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)))

let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}

/* --------------------------------------------------------------------------------------------- *
 * guard-unprovisioned-worktree: a worktree the setup script has not run in.
 *
 * Claude Code makes its own worktrees, on a `worktree-<name>` branch, and no hook fires after it
 * makes one, so nothing runs `scripts/setup-worktree.mjs` for the session. This guard is what makes
 * that script the first command: in a linked worktree whose branch is not `agent/<name>` it must
 * refuse every command but the setup, run plainly. The branch name is the signal, since the setup's
 * first step is the rename. Until 2026-10-08 the check lived in `guard-git.mjs`, which the
 * high-risk floor holds; `guard-git.mjs` must let the same command through, or the check would
 * still be on the floor.
 *
 * The controls matter as much as the refusals: a guard that let any command through that names the
 * setup script would be opened by `node scripts/setup-worktree.mjs; rm -rf .`, so a chained
 * command, a quoted argument and another script of a like name must each still be refused.
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
// With no cwd in the payload the hook looks at the process's directory, which is still the native
// worktree.
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
check(
  'the refusal names the setup command to run',
  native.stderr.includes('node scripts/setup-worktree.mjs <issue id>-<slug>'),
  JSON.stringify(native.stderr.slice(0, 300)),
)
// The one command the guard lets through there, and only run plainly.
for (const [label, command] of [
  ['the setup script, with a name', 'node scripts/setup-worktree.mjs demo-1-fix'],
  ['the setup script, with no argument', 'node scripts/setup-worktree.mjs'],
  ['the setup script, with its options', 'node ./scripts/setup-worktree.mjs demo-1-fix --no-install --task demo-1'],
]) {
  const r = guardFrom(nativeDir, { hook: PROVISION_GUARD, command })
  check(`a worktree-* branch may run ${label}`, r.code === 0, `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 200))}`)
}
for (const [label, command] of [
  ['with a command chained after it', 'node scripts/setup-worktree.mjs demo-1-fix; rm -rf .'],
  ['with a command chained before it', 'cd /tmp && node scripts/setup-worktree.mjs demo-1-fix'],
  ['with a substitution as its argument', 'node scripts/setup-worktree.mjs $(cat name.txt)'],
  ['with a quoted argument', 'node scripts/setup-worktree.mjs "demo 1"'],
  ['piped onward', 'node scripts/setup-worktree.mjs demo-1-fix | tee log.txt'],
  ['by another path', 'node /tmp/scripts/setup-worktree.mjs demo-1-fix'],
]) {
  const r = guardFrom(nativeDir, { hook: PROVISION_GUARD, command })
  check(
    `control: the setup script ${label} is refused still`,
    r.code === 2 && r.stderr.includes(PROVISION_RULE),
    `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 200))}`,
  )
}
const likeNamed = guardFrom(nativeDir, { hook: PROVISION_GUARD, command: 'node scripts/setup-worktree.mjs.bak' })
check('control: a script of a like name is refused still', likeNamed.code === 2, `code=${likeNamed.code}`)
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
const OBJECTS_RULE = 'the object store is shared with sibling worktrees'
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
const collected = guardFrom(join(oursDir, 'sub'), { command: 'git gc' })
check(
  'a subdirectory of it, after a cd, refuses a gc, by its reason',
  collected.code === 2 && collected.stderr.includes(OBJECTS_RULE),
  why(collected),
)
// A write to a long-lived branch is no longer this hook's to read: Git's own hooks refuse it,
// whatever its spelling, and `mise run hooks:selftest` holds them. So the guard must let these
// through, or a session would be refused twice by two readings that can disagree.
for (const command of ['git push origin main', 'git checkout main', 'git switch -C release', 'git branch -f main HEAD']) {
  const r = guardFrom(oursDir, { command })
  check(`the guard leaves \`${command}\` to Git's own hooks`, r.code === 0, why(r))
}
const mergedTrunk = guardFrom(oursDir, { command: 'git merge origin/main' })
check(
  'a merge of the trunk into the branch is refused still, by its reason',
  mergedTrunk.code === 2 && mergedTrunk.stderr.includes('rebase onto origin/main rather than merging'),
  why(mergedTrunk),
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
// word must still group commands, or the gc inside this group would be read as the command `{`.
const grouped = ghGuard(oursDir, '{ git gc; }')
check(
  'a brace group still splits statements, so its gc is refused, by its reason',
  refusedFor(grouped, 'the object store is shared with sibling worktrees'),
  why(grouped),
)

// AN INHERITED GIT_DIR: one in the hook's environment outranks the payload's
// cwd, so the guard judged the checkout it named. Each case runs with it and, as its control,
// without any GIT_* key, and both must give the same verdict, by its reason: the unfixed guard
// refused a command from a subdirectory by the stray rule's reason, so asserting the refusal alone
// passed. The primary checkout's value is the one git exports to a hook run from that worktree.
console.log('guard-git: an inherited GIT_DIR does not move the checkout judged')
const GC_RULE = 'the object store is shared with sibling worktrees'
const SHARED_GIT_DIR = { GIT_DIR: join(primary, '.git') }
const WORKTREE_GIT_DIR = { GIT_DIR: join(primary, '.git', 'worktrees', 'ours') }
for (const [label, dir, command, env, reason] of [
  ['a gc from the worktree', oursDir, 'git gc', SHARED_GIT_DIR, GC_RULE],
  ['a gc from a subdirectory of it', join(oursDir, 'sub'), 'git gc', SHARED_GIT_DIR, GC_RULE],
  ['a merge now from the worktree', oursDir, 'gh pr merge 1 --rebase', SHARED_GIT_DIR, MERGE_RULE],
  ['a gc from the primary checkout', primary, 'git gc', WORKTREE_GIT_DIR, null],
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

// THE IMAGE'S HALF OF A PRUNE. git cannot tell a worktree that was removed from one whose path it
// cannot see, and in a container on a bind-mounted clone every worktree made on the host is the
// second kind. On 2026-10-06 a prune run there took the record of every one of them (the guard's
// header has the incident). `git gc` prunes a stale record too, once its index is older than
// gc.worktreePruneExpire. No selftest builds the image, so this reads the Dockerfile's text.
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
// The renderer fills the CLI's substitutions first, and one of them, CLI_VIA_MERGE, holds briefing
// placeholders of its own. So the count is taken from the template as that step leaves it, for the
// CLI the renderer chose.
const EXPANDED = renderCliText(TEMPLATE_TEXT, activeIntegration(rendered.checkout, GIT_ENV))
for (const [key, value] of Object.entries(renderedValues)) {
  const want = EXPANDED.split(`{{${key}}}`).length - 1
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
 * that changes only the template, and runs the checkout's copy of the script from the checkout. The
 * briefing must be the base's template, rendered, word for word: the script runs the new worktree's
 * own setup script, which runs that worktree's renderer. The negative is the script doctored to run
 * a setup that uses the checkout's renderer, which must render the checkout's template: without it,
 * a scratch repository whose two templates never differed would pass the case.
 * --------------------------------------------------------------------------------------------- */
console.log("new-worktree: the briefing is the base's template, not the checkout's")
const PROVISION = resolve(HOOKS, '..', 'new-worktree.sh')
const SETUP_SCRIPT = resolve(HOOKS, '..', 'setup-worktree.mjs')
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
copyFileSync(SETUP_SCRIPT, join(trailingPrimary, 'scripts', 'setup-worktree.mjs'))
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
 * one unless named), as the prompts run it, and return the run with the worktree's path
 * and the briefing it wrote. The variables the script reads are pinned, so a developer's own
 * `WORKTREE_ROOT` or `TRUNK_BRANCH` cannot move the case.
 */
function provision(script, name, primary = trailingPrimary, env = {}) {
  const worktrees = join(primary, '.claude', 'worktrees')
  const r = spawnSync('bash', [script, name], {
    cwd: primary,
    env: { ...GIT_ENV, WORKTREE_ROOT: worktrees, TRUNK_BRANCH: 'main', LIFETIME_HOURS: '2', ...env },
    encoding: 'utf8',
  })
  const briefing = join(worktrees, name, '.worktree', 'CONTEXT.md')
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
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

const RUNS_ITS_OWN = '(cd "$WORKTREE_PATH" && node scripts/setup-worktree.mjs '
const RENDERS_ITS_OWN = "join(worktree, 'scripts', 'render-worktree-context.mjs')"
const provisionSource = readFileSync(PROVISION, 'utf8')
const setupSource = readFileSync(SETUP_SCRIPT, 'utf8')
const doctoredSetup = join(trailing, 'setup-worktree.doctored.mjs')
writeFileSync(doctoredSetup, setupSource.replace(RENDERS_ITS_OWN, "join(primary, 'scripts', 'render-worktree-context.mjs')"))
const doctoredScript = join(trailing, 'new-worktree.doctored.sh')
writeFileSync(doctoredScript, provisionSource.replace(RUNS_ITS_OWN, `(cd "$WORKTREE_PATH" && node '${doctoredSetup}' `))
check(
  "negative: the doctoring reaches the script's setup line and the setup's renderer line",
  provisionSource.includes(RUNS_ITS_OWN) && setupSource.includes(RENDERS_ITS_OWN),
  `no ${RUNS_ITS_OWN} in scripts/new-worktree.sh, or no ${RENDERS_ITS_OWN} in scripts/setup-worktree.mjs`,
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
copyFileSync(SETUP_SCRIPT, join(racePrimary, 'scripts', 'setup-worktree.mjs'))
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
const ADDS_WORKTREE = 'git -C "$REPO_ROOT" worktree add --lock --reason "$LOCK_REASON" "$WORKTREE_PATH" "$BRANCH"'
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
 * new-worktree.sh: the lock a worktree is added with, and the commit identity set in it.
 *
 * THE LOCK. On 2026-10-06 a `git worktree prune` run in a dev container took the record of every
 * worktree made on the host, whose paths the container cannot see (the section "a worktree record
 * this checkout cannot see" has the incident). A command guard refuses a prune a session types, and
 * that one was run by a hook. So the script adds each worktree locked: git must then refuse to
 * remove it, and a prune must keep its record once its directory is gone, which is the shape a host
 * worktree has in the container. The negative is the script doctored to add with no lock, whose
 * record the same prune must take: without it, a git that pruned nothing would pass the case. A run
 * that fails after the add must still remove its own locked worktree; the negative there is the
 * trap doctored back to one --force, which must leave the worktree behind.
 *
 * THE IDENTITY. No incident in this repository. In a Target, a pull request opened on 2026-11-07
 * carried three agent commits authored as the operator, because a session on a host commits under
 * the operator's git config. `github-app-token.mjs identity` here is a stand-in that prints a bot
 * account, or refuses as a project with no App does; that script's own selftest holds what the real
 * one prints. The worktree's commits must carry the bot, with HEAD detached too, as a rebase leaves
 * it; the primary checkout's must not. With no App, no identity is set and the shared config is not
 * written. With `.git/config.lock` held and per-worktree config off, the run must warn and still
 * make the worktree; with it on already, the run writes no shared config and sets the identity.
 * --------------------------------------------------------------------------------------------- */
console.log('new-worktree: the lock, and the commit identity')
const lockRoot = mkdtempSync(join(tmpdir(), 'wt-lock-'))
const lockPrimary = join(lockRoot, 'primary')
const lockOrigin = join(lockRoot, 'origin.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', lockOrigin], { env: GIT_ENV })
execFileSync('git', ['init', '-q', '-b', 'main', lockPrimary], { env: GIT_ENV })
mkdirSync(join(lockPrimary, 'scripts'))
mkdirSync(join(lockPrimary, '.harness'))
copyAdapters(lockPrimary)
copyFileSync(PROVISION, join(lockPrimary, 'scripts', 'new-worktree.sh'))
copyFileSync(RENDERER, join(lockPrimary, 'scripts', 'render-worktree-context.mjs'))
copyFileSync(SETUP_SCRIPT, join(lockPrimary, 'scripts', 'setup-worktree.mjs'))
const BOT = { name: 'example-agent[bot]', email: '7+example-agent[bot]@users.noreply.github.com' }
writeFileSync(
  join(lockPrimary, 'scripts', 'github-app-token.mjs'),
  `if (process.argv[2] !== 'identity' || process.env.STUB_NO_APP) process.exit(1)\n` +
    `process.stdout.write('user.name=${BOT.name}\\nuser.email=${BOT.email}\\n')\n`,
)
const lockTemplate = join(lockPrimary, '.harness', 'worktree-CONTEXT.md.tmpl')
writeFileSync(lockTemplate, templateOf('base'))
git(lockPrimary, 'add', '.')
git(lockPrimary, ...AS, 'commit', '-qm', 'a checkout worktrees are cut from')
git(lockPrimary, 'remote', 'add', 'origin', lockOrigin)
git(lockPrimary, 'push', '-q', 'origin', 'main')
const lockScript = join(lockPrimary, 'scripts', 'new-worktree.sh')
const lockRecord = (name) => existsSync(join(lockPrimary, '.git', 'worktrees', name))
/** A git command in the scratch checkout that may fail: its status and both streams. */
const tryGit = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' }
}
const worktreeConfigOn = () => tryGit(lockPrimary, 'config', '--local', '--get', 'extensions.worktreeConfig').out === 'true'

// With no App first, while per-worktree config is still off in this scratch repository.
const noApp = provision(lockScript, 'no-app', lockPrimary, { STUB_NO_APP: '1' })
check(
  'with no App, the script provisions, sets no identity and says whose commits these are',
  noApp.code === 0 && tryGit(noApp.path, 'config', 'user.email').out === '' && /^commits:  yours/m.test(noApp.stdout),
  `${raceWhy(noApp)} ${JSON.stringify(noApp.stdout.slice(0, 300))}`,
)
check('and leaves per-worktree config off in the shared config', !worktreeConfigOn())

const lockHeldOff = join(lockPrimary, '.git', 'config.lock')
writeFileSync(lockHeldOff, '')
const heldOff = provision(lockScript, 'held-off', lockPrimary)
check(
  'with .git/config.lock held and per-worktree config off, it warns and still makes the worktree',
  heldOff.code === 0 && heldOff.text !== '' && heldOff.stderr.includes("could not set the App's commit identity") && !worktreeConfigOn(),
  raceWhy(heldOff),
)
rmSync(lockHeldOff, { force: true })

const locked = provision(lockScript, 'locked', lockPrimary)
const lockedListing = tryGit(lockPrimary, 'worktree', 'list', '--porcelain').out
check(
  'a worktree is added locked, with the reason git gives back',
  locked.code === 0 && new RegExp(`^worktree .*locked\\n(?:.+\\n)*locked an agent's worktree for agent/locked`, 'm').test(lockedListing),
  `${raceWhy(locked)} ${JSON.stringify(lockedListing)}`,
)
const refusedRemove = tryGit(lockPrimary, 'worktree', 'remove', locked.path)
check(
  'git refuses to remove it, by the lock',
  refusedRemove.code !== 0 && refusedRemove.err.includes('locked working tree') && existsSync(locked.path),
  refusedRemove.err,
)
const identityOf = (dir, ...format) => tryGit(dir, 'log', '-1', `--format=${format.join('|')}`).out
check(
  "its commit identity is the App's bot, in the worktree's own config",
  tryGit(locked.path, 'config', 'user.name').out === BOT.name &&
    tryGit(locked.path, 'config', 'user.email').out === BOT.email &&
    worktreeConfigOn() &&
    new RegExp(`^commits:  ${BOT.name.replace(/[[\]]/g, '\\$&')} <`, 'm').test(locked.stdout),
  `${tryGit(locked.path, 'config', 'user.email').out} ${JSON.stringify(locked.stdout.slice(0, 300))}`,
)
check(
  "and not the primary checkout's, whose config names nobody",
  tryGit(lockPrimary, 'config', 'user.email').out === '' && tryGit(lockPrimary, 'config', 'user.name').out === '',
  tryGit(lockPrimary, 'config', 'user.email').out,
)
tryGit(locked.path, 'checkout', '-q', '--detach')
const detachedCommit = tryGit(locked.path, 'commit', '-q', '--allow-empty', '-m', 'made with HEAD detached, as a rebase leaves it')
check(
  'a commit made there with HEAD detached carries the bot as author and committer',
  detachedCommit.code === 0 && identityOf(locked.path, '%an', '%ae', '%cn', '%ce') === [BOT.name, BOT.email, BOT.name, BOT.email].join('|'),
  `${detachedCommit.err} ${identityOf(locked.path, '%an', '%ae', '%cn', '%ce')}`,
)

const lockHeldOn = join(lockPrimary, '.git', 'config.lock')
writeFileSync(lockHeldOn, '')
const heldOn = provision(lockScript, 'held-on', lockPrimary)
check(
  'with .git/config.lock held and per-worktree config on already, it sets the identity and warns of nothing',
  heldOn.code === 0 && tryGit(heldOn.path, 'config', 'user.email').out === BOT.email && !heldOn.stderr.includes('could not set'),
  raceWhy(heldOn),
)
rmSync(lockHeldOn, { force: true })

// The shape a host worktree has in a dev container: its record stays, its directory cannot be seen.
rmSync(locked.path, { recursive: true, force: true })
git(lockPrimary, 'worktree', 'prune')
check('a prune keeps the record of a locked worktree whose directory is gone', lockRecord('locked'))
const LOCKS = ' --lock --reason "$LOCK_REASON"'
check('negative: the doctoring reaches the lock', provisionSource.includes(LOCKS), `no${LOCKS} in scripts/new-worktree.sh`)
const unlockedScript = join(lockRoot, 'new-worktree.unlocked.sh')
writeFileSync(unlockedScript, provisionSource.replace(LOCKS, ''))
const unlocked = provision(unlockedScript, 'unlocked', lockPrimary)
rmSync(unlocked.path, { recursive: true, force: true })
git(lockPrimary, 'worktree', 'prune')
check(
  'doctored to add with no lock, the same prune takes the record',
  unlocked.code === 0 && !lockRecord('unlocked'),
  raceWhy(unlocked),
)

// A run that fails after the add: the base moves on to a template the renderer refuses.
writeFileSync(lockTemplate, 'a placeholder the renderer does not supply: {{NOT_SUPPLIED}}\n')
git(lockPrimary, ...AS, 'commit', '-qam', 'a template the renderer refuses')
git(lockPrimary, 'push', '-q', 'origin', 'main')
const failedAfterAdd = provision(lockScript, 'fails-late', lockPrimary)
check(
  'a run that fails after the add removes its own locked worktree, record and branch',
  failedAfterAdd.code !== 0 &&
    failedAfterAdd.stderr.includes('removing the worktree') &&
    !existsSync(failedAfterAdd.path) &&
    !lockRecord('fails-late') &&
    tryGit(lockPrimary, 'rev-parse', '--verify', '--quiet', 'refs/heads/agent/fails-late').code !== 0,
  raceWhy(failedAfterAdd),
)
const TWICE_FORCED = 'worktree remove --force --force "$WORKTREE_PATH"'
check('negative: the doctoring reaches the trap', provisionSource.includes(TWICE_FORCED), `no ${TWICE_FORCED} in scripts/new-worktree.sh`)
const onceForcedScript = join(lockRoot, 'new-worktree.once-forced.sh')
writeFileSync(onceForcedScript, provisionSource.replace(TWICE_FORCED, 'worktree remove --force "$WORKTREE_PATH"'))
const leftBehind = provision(onceForcedScript, 'left-behind', lockPrimary)
check(
  'doctored back to one --force, the trap leaves the locked worktree behind',
  leftBehind.code !== 0 && existsSync(leftBehind.path) && lockRecord('left-behind'),
  raceWhy(leftBehind),
)

/* --------------------------------------------------------------------------------------------- *
 * setup-worktree.mjs: a worktree Claude Code made.
 *
 * Claude Code cuts `worktree-<name>` from origin's default branch and runs nothing of this
 * repository's, so the setup script is what turns that into the worktree the prompts and the hooks
 * expect. A stand-in for Claude Code's own `git worktree add` makes each one here: `--no-track`, on
 * `worktree-<name>`, under `.claude/worktrees/`. No incident yet, since the script is new with
 * this change; the cases hold what its header promises.
 *
 * The rename must write no shared config, because lanes that start together would race for its
 * lock: with `.git/config.lock` held it must still rename. A worktree whose base trails
 * `origin/main` must be brought up to it, and the negative is the script with that step taken out,
 * which must leave the worktree behind: without it, a scratch repository whose trunk never moved
 * would pass the case. A worktree cut from a commit `origin/main` does not hold is refused. A
 * subagent's worktree, named `agent-<id>`, names no issue, so the script must ask for the name. An
 * `agent/<name>` branch with no commit of its own is what Claude Code leaves behind when it removes
 * an unchanged worktree, and must be replaced; one that holds work must not be.
 * --------------------------------------------------------------------------------------------- */
console.log('setup-worktree: a worktree Claude Code made')
const nativeRoot = mkdtempSync(join(tmpdir(), 'wt-setup-'))
const nativePrimary = join(nativeRoot, 'primary')
const nativeOrigin = join(nativeRoot, 'origin.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', nativeOrigin], { env: GIT_ENV })
execFileSync('git', ['init', '-q', '-b', 'main', nativePrimary], { env: GIT_ENV })
mkdirSync(join(nativePrimary, 'scripts'))
mkdirSync(join(nativePrimary, '.harness'))
copyAdapters(nativePrimary)
copyFileSync(RENDERER, join(nativePrimary, 'scripts', 'render-worktree-context.mjs'))
copyFileSync(SETUP_SCRIPT, join(nativePrimary, 'scripts', 'setup-worktree.mjs'))
copyFileSync(join(lockPrimary, 'scripts', 'github-app-token.mjs'), join(nativePrimary, 'scripts', 'github-app-token.mjs'))
writeFileSync(join(nativePrimary, '.harness', 'worktree-CONTEXT.md.tmpl'), templateOf('base'))
writeFileSync(join(nativePrimary, '.gitignore'), '.worktree/\n.claude/worktrees/\n')
git(nativePrimary, 'add', '.')
git(nativePrimary, ...AS, 'commit', '-qm', 'the commit worktrees are cut from')
git(nativePrimary, 'remote', 'add', 'origin', nativeOrigin)
git(nativePrimary, 'push', '-q', 'origin', 'main')
const nativeBase = git(nativePrimary, 'rev-parse', 'HEAD').trim()
/** A worktree as Claude Code makes one: `worktree-<name>`, untracked, under `.claude/worktrees/`. */
const claudeWorktree = (name, from = 'origin/main') => {
  const dir = join(nativePrimary, '.claude', 'worktrees', name)
  git(nativePrimary, 'worktree', 'add', '-q', '--no-track', '-b', `worktree-${name}`, dir, from)
  return dir
}
/** The setup script run in `dir`, from this checkout's copy unless `script` names another. */
const setUp = (dir, args = [], { script = join(dir, 'scripts', 'setup-worktree.mjs'), env = {} } = {}) => {
  const r = spawnSync('node', [script, ...args], { cwd: dir, env: { ...GIT_ENV, LIFETIME_HOURS: '2', ...env }, encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const setupWhy = (r) => `code=${r.code} ${JSON.stringify((r.stderr || r.stdout).slice(0, 400))}`
const branchOf = (dir) => tryGit(dir, 'symbolic-ref', '--short', 'HEAD').out
const hasBranch = (name) => tryGit(nativePrimary, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`).code === 0

const entered = claudeWorktree('demo-1-fix')
const first = setUp(entered)
check(
  'it renames worktree-<name> to agent/<name>, from the directory name, and the old branch is gone',
  first.code === 0 && branchOf(entered) === 'agent/demo-1-fix' && !hasBranch('worktree-demo-1-fix'),
  `${setupWhy(first)} branch=${branchOf(entered)}`,
)
check(
  "it sets the App's bot as the commit identity there, and not in the primary checkout",
  tryGit(entered, 'config', 'user.email').out === BOT.email && tryGit(nativePrimary, 'config', 'user.email').out === '',
  tryGit(entered, 'config', 'user.email').out,
)
check(
  'it renders the briefing, with the branch it named',
  existsSync(join(entered, '.worktree', 'CONTEXT.md')) && readFileSync(join(entered, '.worktree', 'CONTEXT.md'), 'utf8').includes('agent/demo-1-fix cut at'),
  setupWhy(first),
)
check('the guard that refused the worktree now allows a command there', guardFrom(entered, { hook: PROVISION_GUARD }).code === 0)
const briefingWas = readFileSync(join(entered, '.worktree', 'CONTEXT.md'), 'utf8')
const again = setUp(entered)
check(
  'run again, it changes nothing and keeps the briefing',
  again.code === 0 && branchOf(entered) === 'agent/demo-1-fix' && again.stdout.includes('(already there, kept)') &&
    readFileSync(join(entered, '.worktree', 'CONTEXT.md'), 'utf8') === briefingWas,
  setupWhy(again),
)
const otherName = setUp(entered, ['demo-2-other'])
check('run again with another name, it refuses', otherName.code === 1 && otherName.stderr.includes('already on agent/demo-1-fix'), setupWhy(otherName))

const lane = claudeWorktree('agent-0a1b2c3d4e5f')
const unnamed = setUp(lane)
check(
  "a subagent's worktree, named agent-<id>, is refused without a name, and stays as it was",
  unnamed.code === 1 && unnamed.stderr.includes('names no issue') && branchOf(lane) === 'worktree-agent-0a1b2c3d4e5f',
  setupWhy(unnamed),
)
const setupLock = join(nativePrimary, '.git', 'config.lock')
writeFileSync(setupLock, '')
const laneNamed = setUp(lane, ['demo-3-lane'])
rmSync(setupLock, { force: true })
check(
  'given a name, and with .git/config.lock held, it renames the branch and sets the identity',
  laneNamed.code === 0 && branchOf(lane) === 'agent/demo-3-lane' && tryGit(lane, 'config', 'user.email').out === BOT.email && !laneNamed.stderr.includes('could not'),
  `${setupWhy(laneNamed)} branch=${branchOf(lane)}`,
)
const badName = setUp(claudeWorktree('demo-4-bad'), ['../escape'])
check('a name that cannot be a branch is refused', badName.code === 1 && badName.stderr.includes('cannot name a branch'), setupWhy(badName))

// The trunk moves on, and a worktree is cut from where it was: Claude Code fetches at most daily.
writeFileSync(join(nativePrimary, 'later.txt'), 'the trunk moved on\n')
git(nativePrimary, 'add', 'later.txt')
git(nativePrimary, ...AS, 'commit', '-qm', 'the trunk moves on')
git(nativePrimary, 'push', '-q', 'origin', 'main')
const nativeTip = git(nativePrimary, 'rev-parse', 'HEAD').trim()
const stale = claudeWorktree('demo-5-stale', nativeBase)
const caughtUp = setUp(stale)
check(
  'a worktree cut behind origin/main is brought up to it',
  caughtUp.code === 0 && git(stale, 'rev-parse', 'HEAD').trim() === nativeTip,
  `${setupWhy(caughtUp)} head=${git(stale, 'rev-parse', '--short', 'HEAD').trim()}`,
)
const FAST_FORWARDS = "git(worktree, 'merge', '--ff-only', '--quiet', TRUNK_REMOTE)"
check('negative: the doctoring reaches the fast-forward', setupSource.includes(FAST_FORWARDS), `no ${FAST_FORWARDS} in scripts/setup-worktree.mjs`)
const noForwardSetup = join(nativeRoot, 'setup-worktree.no-forward.mjs')
writeFileSync(noForwardSetup, setupSource.replace(FAST_FORWARDS, '{ ok: true }'))
const left = claudeWorktree('demo-6-left', nativeBase)
const leftBehindBase = setUp(left, [], { script: noForwardSetup })
check(
  'with the fast-forward taken out, the same worktree stays behind',
  leftBehindBase.code === 0 && git(left, 'rev-parse', 'HEAD').trim() === nativeBase,
  setupWhy(leftBehindBase),
)

git(nativePrimary, 'switch', '-q', '-c', 'side')
git(nativePrimary, ...AS, 'commit', '-q', '--allow-empty', '-m', 'a commit origin/main does not hold')
const side = git(nativePrimary, 'rev-parse', 'HEAD').trim()
git(nativePrimary, 'switch', '-q', 'main')
const offTrunk = claudeWorktree('demo-7-side', side)
const refusedBase = setUp(offTrunk)
check(
  'a worktree cut from a commit origin/main does not hold is refused, and keeps its branch',
  refusedBase.code === 1 && refusedBase.stderr.includes('which origin/main does not hold') && branchOf(offTrunk) === 'worktree-demo-7-side',
  setupWhy(refusedBase),
)

// What Claude Code leaves when it removes an unchanged worktree after the rename: the branch.
git(nativePrimary, 'branch', '--no-track', 'agent/demo-8-again', 'origin/main')
const reused = setUp(claudeWorktree('demo-8-again'))
check(
  'an agent/<name> branch with no commit of its own is replaced',
  reused.code === 0 && branchOf(join(nativePrimary, '.claude', 'worktrees', 'demo-8-again')) === 'agent/demo-8-again',
  setupWhy(reused),
)
git(nativePrimary, 'branch', '--no-track', 'agent/demo-9-work', side)
const worked = setUp(claudeWorktree('demo-9-work'))
check(
  'control: an agent/<name> branch that holds work is not replaced, and the setup refuses',
  worked.code === 1 && worked.stderr.includes('exists and holds 1 commit(s)') && git(nativePrimary, 'rev-parse', 'agent/demo-9-work').trim() === side,
  setupWhy(worked),
)
const inPrimary = setUp(nativePrimary)
check('in the primary checkout it refuses', inPrimary.code === 1 && inPrimary.stderr.includes('this is the primary checkout'), setupWhy(inPrimary))

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
 * handed and runs nothing, so a hook that acts when it runs is never run by this case. So
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

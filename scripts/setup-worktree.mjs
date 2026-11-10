/**
 * Sets up the worktree it is run in, as the first command of a session there: the branch's name,
 * the commit identity, the installed skills, the briefing and the packages.
 *
 * WHY IT IS ONE COMMAND, RUN INSIDE THE WORKTREE. A worktree here is made in two ways, and this is
 * the code both share. Claude Code makes its own: `EnterWorktree`, `claude --worktree` and a
 * subagent's `isolation: "worktree"` each cut `worktree-<name>` from origin's default branch. Codex,
 * Copilot and OpenCode have no worktree tool, so `scripts/new-worktree.sh` makes theirs, and then
 * runs this. Until 2026-11-10 a WorktreeCreate hook routed Claude Code's tool through that script
 * instead, so the script was the one way. That hook cost more than it held:
 *
 *   - Claude Code removes a worktree it made once its agent finishes with nothing changed, and it
 *     does not remove one a hook made. In a Target, about 50 reviewer worktrees were left behind
 *     that way in two days.
 *   - A subagent's worktree name is `agent-<agent id>`, which the hook could only pass on, so a
 *     lane's branch was `agent/agent-<id>` and named no issue, though the delivery hook finds the
 *     issue in the branch's name (AGENTS.md § Git workflow).
 *
 * WHAT IT DOES, in order. Each step is safe to run again, so a second run changes nothing it need not.
 *
 *   1. THE BRANCH. A worktree on `agent/<name>` keeps it. Any other branch is renamed to
 *      `agent/<name>`, where `<name>` is the argument, or the worktree directory's name when no
 *      argument is given. The rename moves the ref and HEAD and writes no config: `git branch -m`
 *      takes the lock of the one `.git/config` every worktree shares, which lanes started together
 *      race for (`scripts/new-worktree.sh` has the incident), and a branch Claude Code made has no
 *      config to carry over. Before the rename, a worktree with no work of its own is fast-forwarded
 *      to `origin/main`, because Claude Code fetches only when its last fetch is over a day old;
 *      one cut from a commit `origin/main` does not hold is refused. An `agent/<name>` branch left
 *      by an earlier worktree is replaced when it holds no commit `origin/main` lacks, which is
 *      what Claude Code leaves when it removes an unchanged worktree after this rename.
 *   2. THE COMMIT IDENTITY. The GitHub App's bot account, in this worktree's own config and no
 *      other's. On a host, git's identity is the operator's own, so an agent's commit and a commit
 *      the operator made by hand carry one author: in a Target, a pull request opened on 2026-11-07
 *      carried three agent commits authored as the operator. The dev container sets the bot's
 *      identity for its whole user (`.devcontainer/entrypoint.sh`); a host has no such place. It
 *      needs `extensions.worktreeConfig` on in the shared `.git/config`, which this turns on once
 *      per repository, trying again when a concurrent run holds the config's lock: the one shared
 *      write it makes. A run that cannot set the identity says so and goes on. A project Deployed
 *      with no App keeps the operator's identity, as it chose. Where it loses: an operator who
 *      signs commits signs these with a key the bot's address does not own, so GitHub shows them
 *      unverified; and a person who commits by hand inside this worktree commits as the bot unless
 *      they name themselves with `git -c`.
 *   3. THE INSTALLED SKILLS, copied from the primary checkout by its own
 *      `scripts/skill-sources.mjs`, with no network.
 *   4. THE BRIEFING, `.worktree/CONTEXT.md`, rendered by this worktree's own
 *      `scripts/render-worktree-context.mjs`, unless one is already there.
 *   5. THE PACKAGES. `npm ci`, when the worktree holds a lockfile and no `node_modules`.
 *      `--no-install` leaves it out: `scripts/new-worktree.sh` passes it, because the script can run
 *      on a host for a session that runs in a container, and `node_modules` is platform-native.
 *
 * WHAT IT DOES NOT DO. It does not make, lock or remove a worktree. `scripts/new-worktree.sh` adds
 * its worktrees locked, and Claude Code locks and removes its own; a lock set here would make
 * Claude Code's own removal fail. It refuses to run in the primary checkout.
 *
 * THE FAILURE IT EXISTS TO PREVENT. Two ways to make a worktree that drift apart: the defect the
 * WorktreeCreate hook was written to stop. Everything a session relies on in a worktree is set
 * here, so a fix lands for every CLI at once. `scripts/hooks/guard-unprovisioned-worktree.mjs`
 * refuses every other command in a linked worktree until the branch is `agent/<name>`, which is
 * this script's first step.
 *
 *   node scripts/setup-worktree.mjs [<issue id>-<slug>] [--no-install] [--task <ref>]
 *
 * `--task` is the reference the briefing shows, the name when it is not given. `TRUNK_BRANCH` names
 * another trunk than `main`, and `LIFETIME_HOURS` the briefing's window, as `scripts/new-worktree.sh`
 * reads them. Needs `git`, and `npm` for step 5. It prints a summary on stdout and every warning on
 * stderr. Exit 0 when the worktree is set up, 1 when it is not, with the reason.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const TRUNK = process.env.TRUNK_BRANCH || 'main'
const TRUNK_REMOTE = `origin/${TRUNK}`

/** No inherited `GIT_*` variable: one set by a hook this runs under would point git at another checkout. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

function fail(message) {
  console.error(`setup-worktree: ${message}`)
  process.exit(1)
}
const warn = (message) => console.error(`setup-worktree: warning: ${message}`)

/** A git call in `cwd`: `{ ok, out, err }`. */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' })
  if (r.error) fail(`git could not run: ${r.error.message}`)
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** The same call again while another process holds the shared config's lock, three times in all. */
function gitPastConfigLock(cwd, ...args) {
  let r
  for (let attempt = 0; attempt < 3; attempt++) {
    r = git(cwd, ...args)
    if (r.ok || !/could not lock config file/.test(r.err)) return r
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'])
  }
  return r
}

/** A worktree's name becomes a branch's, so it is one path segment of letters, digits, dot, dash or underscore. */
const validName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes('..')

const argv = process.argv.slice(2)
const flags = { install: true, task: null }
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--no-install') flags.install = false
  else if (argv[i] === '--task' && argv[i + 1] !== undefined) flags.task = argv[++i]
  else if (argv[i].startsWith('-')) fail(`unknown option ${argv[i]}. usage: node scripts/setup-worktree.mjs [<issue id>-<slug>] [--no-install] [--task <ref>]`)
  else positional.push(argv[i])
}
if (positional.length > 1) fail('takes one name: <issue id>-<slug>')

/* ============================================================================================= *
 * Where this runs.
 * ============================================================================================= */

const top = git(process.cwd(), 'rev-parse', '--path-format=absolute', '--show-toplevel')
if (!top.ok) fail('this directory is in no git checkout')
const worktree = top.out
const gitDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir').out
const commonDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').out
if (gitDir === commonDir) {
  fail('this is the primary checkout. Run it inside a worktree: the first command of a session there.')
}
const primary = dirname(commonDir)

/* ============================================================================================= *
 * 1. The branch.
 * ============================================================================================= */

const current = git(worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD')
if (!current.ok) fail('HEAD is detached here, so there is no branch to name. Finish or abort the rebase first.')
let branch = current.out
if (branch.startsWith('agent/')) {
  const name = branch.slice('agent/'.length)
  if (positional[0] !== undefined && positional[0] !== name) {
    fail(`this worktree is already on ${branch}, which names ${name}, not ${positional[0]}`)
  }
} else {
  const name = positional[0] ?? basename(worktree)
  if (!validName(name)) fail(`${JSON.stringify(name)} cannot name a branch: use letters, digits, dot, dash or underscore`)
  if (positional[0] === undefined && /^agent-[0-9a-f]+$/.test(name)) {
    fail(`this worktree is named ${name}, which names no issue. Pass the name: node scripts/setup-worktree.mjs <issue id>-<slug>`)
  }
  const target = `agent/${name}`

  // A stale base is cheap to fix now and costs a rebase later. Best effort, and bounded: a sandbox
  // has no network, and a fetch that waits for one must not hold the session's first command.
  const fetched = spawnSync('git', ['fetch', 'origin', TRUNK, '--quiet'], { cwd: worktree, env: ENV, stdio: 'ignore', timeout: 30000 })
  if (fetched.status !== 0) {
    warn(`could not fetch ${TRUNK_REMOTE} (offline or sandboxed); using the local ref`)
  }
  if (git(worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/${TRUNK_REMOTE}`).ok) {
    if (!git(worktree, 'merge-base', '--is-ancestor', 'HEAD', TRUNK_REMOTE).ok) {
      const head = git(worktree, 'rev-parse', '--short', 'HEAD').out
      fail(
        `this worktree is at ${head}, which ${TRUNK_REMOTE} does not hold, so it was not cut from the trunk. ` +
          'Leave it, remove it, and make it again; in Claude Code, `worktree.baseRef` must not be `head`.',
      )
    }
    if (git(worktree, 'status', '--porcelain', '--untracked-files=no').out === '') {
      const forward = git(worktree, 'merge', '--ff-only', '--quiet', TRUNK_REMOTE)
      if (!forward.ok) warn(`could not fast-forward to ${TRUNK_REMOTE}: ${forward.err}`)
    }
  }

  if (git(worktree, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).ok) {
    const elsewhere = git(worktree, 'worktree', 'list', '--porcelain').out.includes(`branch refs/heads/${target}\n`)
    const ahead = git(worktree, 'rev-list', '--count', `${TRUNK_REMOTE}..refs/heads/${target}`)
    if (elsewhere) fail(`${target} is checked out in another worktree. Pick another slug.`)
    if (!ahead.ok || ahead.out !== '0') {
      fail(`${target} exists and holds ${ahead.ok ? ahead.out : 'some'} commit(s) ${TRUNK_REMOTE} lacks. Pick another slug, or ask the operator about that branch.`)
    }
    const dropped = git(worktree, 'update-ref', '-d', `refs/heads/${target}`)
    if (!dropped.ok) fail(`could not replace the empty branch ${target}: ${dropped.err}`)
  }
  // The ref, then HEAD, then the old ref: three writes, and none of them to the shared config.
  const made = git(worktree, 'update-ref', `refs/heads/${target}`, 'HEAD', '')
  if (!made.ok) fail(`could not make ${target}: ${made.err}`)
  const moved = git(worktree, 'symbolic-ref', '-m', `setup-worktree: renamed ${branch} to ${target}`, 'HEAD', `refs/heads/${target}`)
  if (!moved.ok) fail(`could not move HEAD to ${target}: ${moved.err}`)
  git(worktree, 'update-ref', '-d', `refs/heads/${branch}`)
  branch = target
}
const name = branch.slice('agent/'.length)

/* ============================================================================================= *
 * 2. The commit identity.
 * ============================================================================================= */

function worktreeConfigOn() {
  return git(primary, 'config', '--type=bool', '--get', 'extensions.worktreeConfig').out === 'true'
}
/** Per-worktree config on in the shared config, or false when it is off and must stay off. */
function enableWorktreeConfig() {
  if (worktreeConfigOn()) return true
  // With the key on, git stops applying a shared core.worktree or core.bare to the primary checkout
  // alone (git-worktree(1), CONFIGURATION FILE), so a repository that holds either is left as it is.
  if (git(primary, 'config', '--local', '--get', 'core.worktree').out !== '') return false
  if (git(primary, 'config', '--local', '--type=bool', '--get', 'core.bare').out === 'true') return false
  return gitPastConfigLock(primary, 'config', '--local', 'extensions.worktreeConfig', 'true').ok || worktreeConfigOn()
}

let commits = 'yours'
const tokenScript = join(worktree, 'scripts', 'github-app-token.mjs')
if (existsSync(tokenScript)) {
  const identity = spawnSync(process.execPath, [tokenScript, 'identity'], { cwd: worktree, env: ENV, encoding: 'utf8' })
  if (identity.status !== 0) {
    commits = "yours (`node scripts/github-app-token.mjs identity` says why the App's is not used)"
  } else {
    const botName = /^user\.name=(.+)$/m.exec(identity.stdout)?.[1]
    const botEmail = /^user\.email=(.+)$/m.exec(identity.stdout)?.[1]
    const set =
      botName !== undefined && botEmail !== undefined && enableWorktreeConfig() &&
      git(worktree, 'config', '--worktree', 'user.name', botName).ok &&
      git(worktree, 'config', '--worktree', 'user.email', botEmail).ok
    if (set) {
      commits = `${botName} <${botEmail}> (this worktree only)`
    } else {
      commits = "yours (the App's could not be set for this worktree)"
      warn(
        `could not set the App's commit identity for ${worktree}, so commits there carry your own. ` +
          `Run \`git config extensions.worktreeConfig true\` in ${primary} once, then run this again.`,
      )
    }
  }
}

/* ============================================================================================= *
 * 3. The installed skills.
 * ============================================================================================= */

// The primary checkout's copy, which copies from the checkout it sits in: installed skills are
// untracked there, so git brought none across. Its lines go to stderr, as every diagnostic here does.
const skillSources = join(primary, 'scripts', 'skill-sources.mjs')
if (existsSync(skillSources)) {
  const copied = spawnSync(process.execPath, [skillSources, 'copy', worktree], { cwd: primary, env: ENV, stdio: ['ignore', 2, 2] })
  if (copied.status !== 0) warn(`could not copy the installed skills into ${worktree}`)
}

/* ============================================================================================= *
 * 4. The briefing.
 * ============================================================================================= */

const briefing = join(worktree, '.worktree', 'CONTEXT.md')
const rendered = {}
if (!existsSync(briefing)) {
  const base = git(worktree, 'merge-base', 'HEAD', TRUNK_REMOTE)
  const baseSha = git(worktree, 'rev-parse', '--short', base.ok ? base.out : 'HEAD').out
  const render = spawnSync(
    process.execPath,
    [join(worktree, 'scripts', 'render-worktree-context.mjs'), worktree, branch, baseSha, flags.task ?? name, process.env.LIFETIME_HOURS || '2'],
    { cwd: worktree, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 2] },
  )
  if (render.status !== 0) fail('the briefing could not be rendered (the reason is above)')
  for (const line of render.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) rendered[line.slice(0, at)] = line.slice(at + 1)
  }
}

/* ============================================================================================= *
 * The summary, then 5. the packages.
 * ============================================================================================= */

console.log(`worktree: ${worktree}`)
console.log(`branch:   ${branch}`)
console.log(`commits:  ${commits}`)
if (rendered.APP_PORT) {
  console.log(`ports:    ${rendered.APP_PORT} / ${rendered.SB_PORT} (reserved: the first for a server's PORT, the second unused)`)
  console.log(`deadline: ${rendered.DEADLINE}`)
}
console.log(`briefing: ${briefing}${rendered.APP_PORT ? '' : ' (already there, kept)'}`)

const needsPackages = existsSync(join(worktree, 'package-lock.json')) && !existsSync(join(worktree, 'node_modules'))
if (!flags.install) {
  if (needsPackages) console.log('packages: not installed. The first command there is `node scripts/setup-worktree.mjs`, which runs `npm ci`.')
} else if (needsPackages) {
  const npm = spawnSync('npm', ['ci'], { cwd: worktree, env: process.env, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' })
  if (npm.status !== 0) fail('`npm ci` failed (the reason is above). The rest of the setup is done: run `npm ci` again once it can reach the registry.')
  console.log('packages: installed with `npm ci`')
} else {
  console.log('packages: nothing to install')
}
console.log('next:     read .worktree/CONTEXT.md')

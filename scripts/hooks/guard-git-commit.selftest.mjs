/**
 * The git guard's commit-identity rule: `guard-git.mjs` run as the harness runs it on `git commit`,
 * over a scratch repository whose config gives the operator's identity, with a lane's worktree on
 * an `agent/` branch. `worktree-hooks.selftest.mjs` holds the guard's other rules.
 *
 * THE FAILURE THIS PREVENTS. PR #5, opened on 2026-11-07, carried three agent commits authored as
 * the operator, because a session on the host commits under the operator's git config unless its
 * command sets another identity (ss-zxj). Were this selftest wrong, the guard could stop refusing
 * such a commit, or start refusing the sweep's own forms, and every commit and push would still
 * pass.
 *
 * The undoctored control is a lane's commit with the four identity variables set to the bot in its
 * own statement, judged against a copy of the live policy. Each other case changes one thing, and
 * each refusal is asserted by its reason. The dispatcher's `git cherry-pick` with the two committer
 * variables, the briefing's `git rebase`, and a push of a branch carrying a commit the operator made
 * must all pass. The policy is read through `GUARD_GIT_ROOT`, the guard's root override, so a copy
 * that names no App, and a missing one, show the rule reads the copy. The bot's identity is checked
 * against what `scripts/github-app-token.mjs identity` prints, so the two cannot drift apart.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-commit.selftest.mjs)
 *
 * Needs `git` and Node. It writes only under the temporary directory, and reads no personal git
 * config.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HOOKS, '..', '..')
const GUARD = join(HOOKS, 'guard-git.mjs')
const LIVE_SETTINGS = readFileSync(join(ROOT, 'policy', 'tool-settings.json'), 'utf8')
const live = JSON.parse(LIVE_SETTINGS)
const RULE = "a session commits on an `agent/` branch as the agents' GitHub App's bot"

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}

// Every GIT_* variable and EMAIL dropped and no personal config read, so a run from a pre-push hook
// cannot reach the real repository (`worktree-hooks.selftest.mjs` has the incident), and only a
// case's own identity decides it. The runner's root overrides go too, so the live policy is read.
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('GITHUB_APP_') && k !== 'EMAIL' && k !== 'GUARD_GIT_ROOT'),
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

const BOT = live.githubAppBotLogin
const BOT_EMAIL = `${live.githubAppBotUserId}+${BOT}@users.noreply.github.com`
const OPERATOR = 'Operator Person'
const OPERATOR_EMAIL = 'operator@example.invalid'
const AUTHOR_VARS = `GIT_AUTHOR_NAME='${BOT}' GIT_AUTHOR_EMAIL='${BOT_EMAIL}'`
const COMMITTER_VARS = `GIT_COMMITTER_NAME='${BOT}' GIT_COMMITTER_EMAIL='${BOT_EMAIL}'`
const FOUR = `${AUTHOR_VARS} ${COMMITTER_VARS}`
const BOT_ENV = { GIT_AUTHOR_NAME: BOT, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_COMMITTER_NAME: BOT, GIT_COMMITTER_EMAIL: BOT_EMAIL }

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-commit-'))
try {
  const primary = join(scratch, 'primary')
  const lane = join(primary, '.claude', 'worktrees', 'lane')
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  // The operator's identity, as the checkout's config gives it on the host.
  git(primary, 'config', 'user.name', OPERATOR)
  git(primary, 'config', 'user.email', OPERATOR_EMAIL)
  writeFileSync(join(primary, 'f.txt'), 'one\n')
  git(primary, 'add', 'f.txt')
  git(primary, 'commit', '-qm', 'init')
  git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(primary, 'worktree', 'add', '-q', '-b', 'agent/lane', lane, 'HEAD')
  // A commit the operator made, carried onto the lane's branch.
  writeFileSync(join(lane, 'f.txt'), 'two\n')
  git(lane, 'commit', '-qam', 'the operator made this')

  /** A copy of the live policy for `GUARD_GIT_ROOT`, edited by `edit`, or none when `edit` is `null`. */
  const policyCopy = (name, edit) => {
    const root = join(scratch, name)
    mkdirSync(join(root, 'policy'), { recursive: true })
    if (edit !== null) writeFileSync(join(root, 'policy', 'tool-settings.json'), edit(LIVE_SETTINGS))
    return root
  }
  const undoctored = policyCopy('undoctored', (text) => text)
  const noApp = policyCopy('no-app', (text) =>
    JSON.stringify({ ...JSON.parse(text), githubAppId: '', githubAppInstallationId: '', githubAppBotLogin: '', githubAppBotUserId: '' }),
  )
  const noPolicy = policyCopy('no-policy', null)

  /** guard-git on `command` typed from `dir`, with the policy under `root` and `env` in the session's environment. */
  const guard = (dir, command, { root = undoctored, env = {} } = {}) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ cwd: dir, tool_input: { command } }),
      cwd: dir,
      env: { ...GIT_ENV, GUARD_GIT_ROOT: root, ...env },
      encoding: 'utf8',
    })
    return { code: r.status ?? 1, stderr: r.stderr ?? '' }
  }
  const why = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 300))}`

  console.log("guard-git: a session's commit on an agent branch carries the App's bot identity")
  const identity = spawnSync(process.execPath, [join(ROOT, 'scripts', 'github-app-token.mjs'), 'identity'], { env: GIT_ENV, encoding: 'utf8' })
  check(
    "the bot's identity here is the one scripts/github-app-token.mjs identity prints",
    identity.status === 0 && identity.stdout === `user.name=${BOT}\nuser.email=${BOT_EMAIL}\n`,
    `exit ${identity.status}: ${JSON.stringify(`${identity.stdout}${identity.stderr}`.trim())}`,
  )

  for (const [label, dir, command, options] of [
    ["a lane's commit with the four identity variables set to the bot (the undoctored control)", lane, `${FOUR} git commit -F msg.txt`, {}],
    ["the dispatcher's cherry-pick with the two committer variables set to the bot", lane, `${COMMITTER_VARS} git cherry-pick 1234567`, {}],
    ["the bot's identity given by -c options", lane, `git -c user.name='${BOT}' -c user.email='${BOT_EMAIL}' commit -m x`, {}],
    ["a plain commit with the bot's identity in the session's environment", lane, 'git commit -m x', { env: BOT_ENV }],
    ["the lane's form run from the primary checkout through -C", primary, `${FOUR} git -C ${lane} commit -m x`, {}],
    ['a plain commit on a branch outside agent/', primary, 'git commit -m x', {}],
    ['a plain commit under a policy that names no App', lane, 'git commit -m x', { root: noApp }],
    ['a plain commit under a policy the guard cannot read, which it does not judge', lane, 'git commit -m x', { root: noPolicy }],
    ['a push of the lane, whose branch carries a commit the operator made', lane, 'git push origin agent/lane', {}],
    ["the briefing's rebase, which keeps each commit's author", lane, 'git rebase origin/main', {}],
  ]) {
    const r = guard(dir, command, options)
    check(`control: the guard allows ${label}`, r.code === 0, why(r))
  }

  for (const [label, dir, command, options] of [
    ["a plain commit, which takes the operator's identity from the checkout's config", lane, 'git commit -m x', {}],
    ["the author variables alone, which leave the committer the operator's", lane, `${AUTHOR_VARS} git commit -m x`, {}],
    ["the committer variables alone, which leave the author the operator's", lane, `${COMMITTER_VARS} git commit -m x`, {}],
    ["the four variables with an author email that is not the bot's", lane, `${FOUR} GIT_AUTHOR_EMAIL='${OPERATOR_EMAIL}' git commit -m x`, {}],
    ['the four variables and an --author naming someone else, which outranks them', lane, `${FOUR} git commit --author='${OPERATOR} <${OPERATOR_EMAIL}>' -m x`, {}],
    ["the four variables and --auth=, git's abbreviation of --author", lane, `${FOUR} git commit --auth='${OPERATOR} <${OPERATOR_EMAIL}>' -m x`, {}],
    [
      'the four variables exported by an earlier statement, which the guard does not read',
      lane,
      `export GIT_AUTHOR_NAME='${BOT}' GIT_AUTHOR_EMAIL='${BOT_EMAIL}' GIT_COMMITTER_NAME='${BOT}' GIT_COMMITTER_EMAIL='${BOT_EMAIL}'; git commit -m x`,
      {},
    ],
    ["the bot's identity in the session's environment, overridden by the statement's author", lane, `GIT_AUTHOR_NAME='${OPERATOR}' git commit -m x`, { env: BOT_ENV }],
    ['a plain commit into the lane from the primary checkout through -C', primary, `git -C ${lane} commit -m x`, {}],
    ['a plain commit after cd into the lane', primary, `cd ${lane} && git commit -m x`, {}],
    ['a plain commit inside bash -c', lane, "bash -c 'git commit -m x'", {}],
  ]) {
    const r = guard(dir, command, options)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(RULE), why(r))
  }

  const plain = guard(lane, 'git commit -m x')
  check(
    'the refusal names the identity git would use and the four variables set to the bot',
    plain.stderr.includes(`author \`${OPERATOR} <${OPERATOR_EMAIL}>\``) && plain.stderr.includes(`\`${FOUR} git commit ...\``),
    JSON.stringify(plain.stderr),
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git commit selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git commit selftest: every case passed')

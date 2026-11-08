/**
 * The git guard's commit-identity rule: `guard-git.mjs` run as the harness runs it on `git commit`
 * and `git revert`, over a scratch repository with lanes on `agent/` branches, where the operator's
 * identity comes from a global git config, as on the host. `worktree-hooks.selftest.mjs` holds most
 * of the guard's other rules; ss-y98 carries those that have no case yet.
 *
 * THE FAILURE THIS PREVENTS. PR #5, opened on 2026-11-07, carried three agent commits authored as
 * the operator, because a session on the host commits under the operator's git config unless its
 * command sets another identity (ss-zxj). Were this selftest wrong, the guard could stop refusing
 * such a commit, or start refusing the sweep's own forms, and every commit and push would still
 * pass.
 *
 * The undoctored control is a lane's `git commit -m x` with the four identity variables set to the
 * bot in its own statement, judged against a copy of the live policy. Each other case changes one
 * thing from the control, or from the allowed case its label names, and each refusal is asserted by
 * its reason. The lanes give each kept author its own case: HEAD by the bot or by the operator, a
 * commit by either to reuse, and a cherry-pick of either stopped on a conflict. A commit made from
 * the operator's is refused by the reason that names it, `--reset-author` and `--author` included,
 * so a session cannot relabel a person's commit as the bot's; the same forms on the bot's commit
 * pass. A tag named like a lane's branch, and a detached HEAD, have lanes of their own. The policy is read through
 * `GUARD_GIT_ROOT`, the guard's root override, so a copy that names no App, a missing one, and one
 * whose bot login is not a bot's, show the rule reads the copy and fails closed. The bot's identity
 * is checked against what `scripts/github-app-token.mjs identity` prints, so the two cannot drift.
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
const NO_BOT_RULE = 'the guard cannot read that bot from `policy/tool-settings.json`'
/** The refusal of a commit made from `source`, a commit of the operator's, as it names both. */
const fromPerson = (source) => `this commit is made from \`${source}\`, which \`${OPERATOR} <${OPERATOR_EMAIL}>\` made, not the agents' GitHub App's bot`

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

const BOT = live.githubAppBotLogin
const BOT_EMAIL = `${live.githubAppBotUserId}+${BOT}@users.noreply.github.com`
const OPERATOR = 'Operator Person'
const OPERATOR_EMAIL = 'operator@example.invalid'
const AUTHOR_VARS = `GIT_AUTHOR_NAME='${BOT}' GIT_AUTHOR_EMAIL='${BOT_EMAIL}'`
const COMMITTER_VARS = `GIT_COMMITTER_NAME='${BOT}' GIT_COMMITTER_EMAIL='${BOT_EMAIL}'`
const FOUR = `${AUTHOR_VARS} ${COMMITTER_VARS}`
const identityEnv = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })
const BOT_ENV = identityEnv(BOT, BOT_EMAIL)
const OPERATOR_ENV = identityEnv(OPERATOR, OPERATOR_EMAIL)

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-commit-'))
try {
  /** git in the scratch repository, as `env`'s identity when it commits. Throws on failure. */
  const git = (cwd, args, env = OPERATOR_ENV) => execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (path, text) => writeFileSync(path, text)
  const primary = join(scratch, 'primary')
  const worktrees = join(primary, '.claude', 'worktrees')
  const lane = (name) => join(worktrees, name)
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  write(join(primary, 'f.txt'), 'one\n')
  git(primary, ['add', 'f.txt'])
  git(primary, ['commit', '-qm', 'init'])
  git(primary, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  // Two commits to cherry-pick, one by the bot and one by the operator, each against main.
  const pickFrom = (branch, text, env) => {
    git(primary, ['switch', '-q', '-c', branch])
    write(join(primary, 'f.txt'), text)
    git(primary, ['commit', '-qam', branch], env)
    const sha = git(primary, ['rev-parse', 'HEAD'])
    git(primary, ['switch', '-q', 'main'])
    return sha
  }
  const BOT_PICK = pickFrom('src-bot', 'bot\n', BOT_ENV)
  const OP_PICK = pickFrom('src-op', 'operator\n', OPERATOR_ENV)
  const addLane = (name, ...extra) => git(primary, ['worktree', 'add', '-q', ...extra, lane(name), 'main'])

  // `lane`: a commit the operator made, carried onto the branch, under the bot's own, which is HEAD.
  addLane('lane', '-b', 'agent/lane')
  write(join(lane('lane'), 'f.txt'), 'carried\n')
  git(lane('lane'), ['commit', '-qam', 'the operator made this'], OPERATOR_ENV)
  const OP_COMMIT = git(lane('lane'), ['rev-parse', 'HEAD'])
  write(join(lane('lane'), 'f.txt'), 'by the bot\n')
  git(lane('lane'), ['commit', '-qam', 'the bot made this'], BOT_ENV)
  const BOT_COMMIT = git(lane('lane'), ['rev-parse', 'HEAD'])
  // `op-head`: HEAD is the operator's commit.
  addLane('op-head', '-b', 'agent/op-head')
  write(join(lane('op-head'), 'f.txt'), 'operator head\n')
  git(lane('op-head'), ['commit', '-qam', 'the operator made this'], OPERATOR_ENV)
  // `pick-bot` and `pick-op`: a cherry-pick of each commit, stopped on a conflict.
  for (const [name, sha] of [['pick-bot', BOT_PICK], ['pick-op', OP_PICK]]) {
    addLane(name, '-b', `agent/${name}`)
    write(join(lane(name), 'f.txt'), 'lane\n')
    git(lane(name), ['commit', '-qam', 'the lane changed f.txt'], BOT_ENV)
    spawnSync('git', ['cherry-pick', sha], { cwd: lane(name), env: { ...GIT_ENV, ...BOT_ENV }, stdio: 'pipe' })
  }
  // `tagged`: a tag named like the branch, so git shortens the branch to `heads/agent/tagged`.
  addLane('tagged', '-b', 'agent/tagged')
  git(lane('tagged'), ['tag', 'agent/tagged'])
  // `detached`: no branch at all.
  addLane('detached', '--detach')

  const operatorConfig = join(scratch, 'operator.gitconfig')
  const botConfig = join(scratch, 'bot.gitconfig')
  write(operatorConfig, `[user]\n\tname = ${OPERATOR}\n\temail = ${OPERATOR_EMAIL}\n`)
  write(botConfig, `[user]\n\tname = ${BOT}\n\temail = ${BOT_EMAIL}\n`)

  /** A copy of the live policy for `GUARD_GIT_ROOT`, edited by `edit`, or none when `edit` is `null`. */
  const policyCopy = (name, edit) => {
    const root = join(scratch, name)
    mkdirSync(join(root, 'policy'), { recursive: true })
    if (edit !== null) write(join(root, 'policy', 'tool-settings.json'), edit(LIVE_SETTINGS))
    return root
  }
  const undoctored = policyCopy('undoctored', (text) => text)
  const noApp = policyCopy('no-app', (text) =>
    JSON.stringify({ ...JSON.parse(text), githubAppId: '', githubAppInstallationId: '', githubAppBotLogin: '', githubAppBotUserId: '' }),
  )
  const noPolicy = policyCopy('no-policy', null)
  const badBot = policyCopy('bad-bot', (text) => JSON.stringify({ ...JSON.parse(text), githubAppBotLogin: 'not-a-bot' }))

  /**
   * guard-git on `command` typed from `dir`, with the policy under `root`, and the operator's global
   * git config and `env` in the session's environment.
   */
  const guard = (dir, command, { root = undoctored, env = {} } = {}) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ cwd: dir, tool_input: { command } }),
      cwd: dir,
      env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: operatorConfig, GUARD_GIT_ROOT: root, ...env },
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
  const picking = ['pick-bot', 'pick-op'].every((name) => spawnSync('git', ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd: lane(name), env: GIT_ENV }).status === 0)
  check('the scratch lanes hold a cherry-pick under way on each pick lane', picking)
  check('the tag makes git shorten the tagged lane to heads/agent/tagged', git(lane('tagged'), ['symbolic-ref', '--short', 'HEAD']) === 'heads/agent/tagged')

  const CONTROL = `${FOUR} git commit -m x`
  for (const [label, dir, command, options] of [
    ["a lane's commit with the four identity variables set to the bot (the undoctored control)", lane('lane'), CONTROL, {}],
    ["a plain commit with the bot's identity in the global git config, as the dev container sets it", lane('lane'), 'git commit -m x', { env: { GIT_CONFIG_GLOBAL: botConfig } }],
    ["a plain commit with the bot's identity given by -c options", lane('lane'), `git -c user.name='${BOT}' -c user.email='${BOT_EMAIL}' commit -m x`, {}],
    ["a plain commit with the bot's identity in the session's environment", lane('lane'), 'git commit -m x', { env: BOT_ENV }],
    ['a plain commit on a branch outside agent/', primary, 'git commit -m x', {}],
    ['a plain commit on a detached HEAD, which the rule does not judge', lane('detached'), 'git commit -m x', {}],
    ['a plain commit under a policy that names no App', lane('lane'), 'git commit -m x', { root: noApp }],
    ["the control run from the primary checkout through -C", primary, `${FOUR} git -C ${lane('lane')} commit -m x`, {}],
    ['the control after cd into the lane', primary, `cd ${lane('lane')} && ${CONTROL}`, {}],
    ['the control inside bash -c', lane('lane'), `bash -c "${CONTROL}"`, {}],
    ["the control with --amend, which keeps HEAD's author, the bot", lane('lane'), `${FOUR} git commit --amend -m x`, {}],
    ["the control with --amend --reset-author on the bot's HEAD", lane('lane'), `${FOUR} git commit --amend --reset-author -m x`, {}],
    ["the control with --amend and an --author naming the bot, on the bot's HEAD", lane('lane'), `${FOUR} git commit --amend --author='${BOT} <${BOT_EMAIL}>' -m x`, {}],
    ["the control with -C naming the bot's commit, whose author it keeps", lane('lane'), `${FOUR} git commit -C ${BOT_COMMIT}`, {}],
    ["the control with -C naming the bot's commit and --reset-author", lane('lane'), `${FOUR} git commit -C ${BOT_COMMIT} --reset-author`, {}],
    ["the dispatcher's commit that ends a cherry-pick of the bot's commit, with the two committer variables", lane('pick-bot'), `${COMMITTER_VARS} git commit -m x`, {}],
    ["git cherry-pick --continue on the operator's commit, which is not judged", lane('pick-op'), 'git cherry-pick --continue', {}],
    ["the dispatcher's cherry-pick with the two committer variables", lane('lane'), `${COMMITTER_VARS} git cherry-pick ${OP_PICK}`, {}],
    ['a revert with the four identity variables set to the bot', lane('lane'), `${FOUR} git revert --no-edit HEAD`, {}],
    ['a plain revert -n, which writes no commit', lane('lane'), 'git revert -n HEAD', {}],
    ['a push of the lane, whose branch carries a commit the operator made', lane('lane'), 'git push origin agent/lane', {}],
    ["the briefing's rebase, which keeps each commit's author", lane('lane'), 'git rebase origin/main', {}],
    ['the control on the lane with a tag named like its branch', lane('tagged'), CONTROL, {}],
  ]) {
    const r = guard(dir, command, options)
    check(`control: the guard allows ${label}`, r.code === 0, why(r))
  }

  for (const [label, dir, command, options, reason] of [
    ["a plain commit, which takes the operator's identity from the global git config", lane('lane'), 'git commit -m x', {}],
    ["the author variables alone, which leave the committer the operator's", lane('lane'), `${AUTHOR_VARS} git commit -m x`, {}],
    ["the committer variables alone, which leave the author the operator's", lane('lane'), `${COMMITTER_VARS} git commit -m x`, {}],
    ["the four variables, then an author email that is not the bot's", lane('lane'), `${FOUR} GIT_AUTHOR_EMAIL='${OPERATOR_EMAIL}' git commit -m x`, {}],
    ['the control with an --author naming someone else, which outranks the variables', lane('lane'), `${FOUR} git commit --author='${OPERATOR} <${OPERATOR_EMAIL}>' -m x`, {}],
    ["the control with --auth=, git's abbreviation of --author", lane('lane'), `${FOUR} git commit --auth='${OPERATOR} <${OPERATOR_EMAIL}>' -m x`, {}],
    [
      'the four variables exported by an earlier statement, which the guard does not read',
      lane('lane'),
      `export GIT_AUTHOR_NAME='${BOT}' GIT_AUTHOR_EMAIL='${BOT_EMAIL}' GIT_COMMITTER_NAME='${BOT}' GIT_COMMITTER_EMAIL='${BOT_EMAIL}'; git commit -m x`,
      {},
    ],
    ["the bot's identity in the session's environment, under the statement's own author name", lane('lane'), `GIT_AUTHOR_NAME='${OPERATOR}' git commit -m x`, { env: BOT_ENV }],
    ['a plain commit into the lane from the primary checkout through -C', primary, `git -C ${lane('lane')} commit -m x`, {}],
    ['a plain commit after cd into the lane', primary, `cd ${lane('lane')} && git commit -m x`, {}],
    ['a plain commit inside bash -c', lane('lane'), 'bash -c "git commit -m x"', {}],
    ["--amend on the bot's HEAD with the author variables alone, which leave the committer the operator's", lane('lane'), `${AUTHOR_VARS} git commit --amend -m x`, {}],
    ["the control with --amend on the operator's HEAD, whose author it keeps", lane('op-head'), `${FOUR} git commit --amend -m x`, {}, fromPerson('HEAD')],
    ["the control with --amen, git's abbreviation of --amend, on the operator's HEAD", lane('op-head'), `${FOUR} git commit --amen -m x`, {}, fromPerson('HEAD')],
    ["the control with --amend --reset-author on the operator's HEAD, which would relabel it as the bot's", lane('op-head'), `${FOUR} git commit --amend --reset-author -m x`, {}, fromPerson('HEAD')],
    ["the control with --amend and an --author naming the bot, on the operator's HEAD", lane('op-head'), `${FOUR} git commit --amend --author='${BOT} <${BOT_EMAIL}>' -m x`, {}, fromPerson('HEAD')],
    ['--amend --reset-author undone by --no-reset-author, on the operator\'s HEAD', lane('op-head'), `${FOUR} git commit --amend --reset-author --no-reset-author -m x`, {}, fromPerson('HEAD')],
    ["the control with -C naming the operator's commit, whose author it keeps", lane('lane'), `${FOUR} git commit -C ${OP_COMMIT}`, {}, fromPerson(OP_COMMIT)],
    ["the control with -C naming the operator's commit and --reset-author", lane('lane'), `${FOUR} git commit -C ${OP_COMMIT} --reset-author`, {}, fromPerson(OP_COMMIT)],
    ["the control with -c naming the operator's commit", lane('lane'), `${FOUR} git commit -c ${OP_COMMIT}`, {}, fromPerson(OP_COMMIT)],
    ["the control with -aC and the operator's commit in one token", lane('lane'), `${FOUR} git commit -aC${OP_COMMIT}`, {}, fromPerson(OP_COMMIT)],
    [
      "the dispatcher's commit that ends a cherry-pick of the operator's commit, whose author it keeps",
      lane('pick-op'),
      `${COMMITTER_VARS} git commit -m x`,
      {},
      fromPerson('CHERRY_PICK_HEAD'),
    ],
    [
      "the control with --reset-author while a cherry-pick of the operator's commit is under way",
      lane('pick-op'),
      `${FOUR} git commit --reset-author -m x`,
      {},
      fromPerson('CHERRY_PICK_HEAD'),
    ],
    ['a revert with the committer variables alone, which leave the author the operator\'s', lane('lane'), `${COMMITTER_VARS} git revert --no-edit HEAD`, {}],
    ['a plain revert, which commits as the operator', lane('lane'), 'git revert HEAD', {}],
    ['a plain commit on the lane with a tag named like its branch', lane('tagged'), 'git commit -m x', {}],
    ['the control under a policy the guard cannot read, where it fails closed', lane('lane'), CONTROL, { root: noPolicy }, NO_BOT_RULE],
    ["the control under a policy whose bot login is not a bot's, where it fails closed", lane('lane'), CONTROL, { root: badBot }, NO_BOT_RULE],
  ]) {
    const r = guard(dir, command, options)
    check(`${label} is refused, by its reason`, r.code === 2 && r.stderr.includes(reason ?? RULE), why(r))
  }

  const plain = guard(lane('lane'), 'git commit -m x')
  check(
    'the refusal names the identity git would use and the four variables set to the bot',
    plain.stderr.includes(`author \`${OPERATOR} <${OPERATOR_EMAIL}>\``) && plain.stderr.includes(`\`${FOUR} git commit ...\``),
    JSON.stringify(plain.stderr),
  )
  const reused = guard(lane('lane'), `${FOUR} git commit -C ${OP_COMMIT} --reset-author`)
  check(
    "the refusal of a commit made from the operator's names it, says leave it as it is, and names git cherry-pick --continue",
    reused.stderr.includes(fromPerson(OP_COMMIT)) && reused.stderr.includes('Leave that commit as it is') && reused.stderr.includes('`git cherry-pick --continue`'),
    JSON.stringify(reused.stderr),
  )
  const keptBot = guard(lane('lane'), `${AUTHOR_VARS} git commit --amend -m x`)
  check(
    "the refusal of a commit that keeps the bot's author names where it is kept from",
    keptBot.stderr.includes(`author \`${BOT} <${BOT_EMAIL}>\`, kept from \`HEAD\`,`),
    JSON.stringify(keptBot.stderr),
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git commit selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git commit selftest: every case passed')

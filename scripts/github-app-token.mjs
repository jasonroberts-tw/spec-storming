/**
 * The agents' GitHub App tokens, for `git` and `gh` in the dev container. It mints an
 * installation access token for the App `githubAppId` names, on the
 * installation `githubAppInstallationId` names (`policy/tool-settings.json`), for the one
 * repository `githubRepository` names, signing the request with the App's private key: the
 * one `.pem` file in the directory `GITHUB_APP_KEY_DIR` names, which
 * `.devcontainer/devcontainer.json` mounts read-only. It keeps the token in a file only
 * its user can read, and hands it out again until fewer than `githubAppTokenRefreshSeconds` of its
 * hour are left; then it mints a fresh one, so a session longer than the token's hour needs no
 * restart. It serves the token two ways:
 *
 *   - `token` prints it. `.devcontainer/gh` runs `gh` with it as `GH_TOKEN`, read afresh for every
 *     command, since `gh` reads no credential helper.
 *   - `git-credential get` answers git's credential protocol with it, as `x-access-token`, for
 *     `https://github.com` alone, and says nothing for any other host or protocol, so the token never
 *     goes to another host. `erase`, which git sends after GitHub refuses a credential, drops the
 *     kept token, so the next `get` mints afresh; `store` does nothing. The image makes
 *     `.devcontainer/git-credential-github-app`, which runs it, git's one helper for github.com, and
 *     rewrites `ssh://git@github.com/` and `git@github.com:` to HTTPS, so the tracker's Dolt remote,
 *     which runs `git` against an SSH address, reaches GitHub through it too.
 *
 * It also prints, with `identity`, the App's bot account as git's commit identity:
 * `githubAppBotLogin` as `user.name`, and `<githubAppBotUserId>+<githubAppBotLogin>@users.noreply.github.com`
 * as `user.email`, which `.devcontainer/entrypoint.sh` sets when none is. That needs no key or token.
 * App ids accept JSON numbers or positive decimal strings, so named placeholders can be filled by
 * plain text substitution while the Template's policy remains valid JSON. Unfilled placeholders
 * and other strings are refused. A project Deployed with no App has all four App keys empty, and
 * every subcommand refuses that by saying changes are made on the host, under the operator's account.
 *
 * The `review` job of `.github/workflows/prompt-review.yml` runs `token` and `identity` too. It names
 * a directory of its own as `GITHUB_APP_KEY_DIR` and `GITHUB_APP_TOKEN_CACHE`, and deletes it once
 * the one token is minted, so nothing there mints a second.
 *
 * THE FAILURE IT EXISTS TO PREVENT. No incident yet: it came with the container that acts as the
 * App. Were it wrong, a session past its first hour would be refused its next
 * push or `gh` call, which reads as a network or permission fault rather than an expired token; a
 * kept token another user could read, or one answered for another host, would hand the App's
 * identity to them; and a key directory holding two keys would sign with whichever it read first,
 * and be refused whenever that one was revoked. A token asked for with no repository reached all 8
 * the installation covered on 2026-10-06, where this one alone was meant. A
 * wrong `identity` would put another account's name or address on every commit the container makes.
 * So it refuses a key directory without exactly one `.pem`, a policy without a key its subcommand
 * reads, and an answer from GitHub without a token and its expiry, each by its reason, and never
 * prints the key or the token in a refusal.
 *
 * INVOCATION.
 *
 *   node scripts/github-app-token.mjs token                     prints a token
 *   node scripts/github-app-token.mjs git-credential <action>   git's credential helper: get, store
 *                                                               or erase, the attributes on stdin
 *   node scripts/github-app-token.mjs identity                  prints `user.name=` and `user.email=`
 *   mise run github-app-token:selftest                          its cases, over a stubbed GitHub
 *   GITHUB_APP_TOKEN_ROOT=<dir>    reads the policy of a doctored copy
 *   GITHUB_APP_API_URL=<url>       another API than https://api.github.com, the selftest's stub
 *   GITHUB_APP_TOKEN_CACHE=<file>  where the token is kept; by default
 *                                  `$XDG_CACHE_HOME/github-app-token/<installation>.json`, under
 *                                  `~/.cache` where that is unset
 *
 * NEEDS. The App's private key under `GITHUB_APP_KEY_DIR`, and GitHub's API over the network, both of
 * which the dev container gives it. Its selftest needs neither, so it is a pre-push job and a
 * `verify.yml` step: it makes a key with `node:crypto`, serves GitHub's endpoint from a stub on
 * loopback, and runs `git credential fill` and `.devcontainer/gh` through real `git` and `sh`, which
 * it skips, saying why, on Windows, where the container's wrappers never run. Since it is the
 * selftest that sources `.devcontainer/entrypoint.sh` and reads the Dockerfile, it also holds the
 * rest of the container's start that needs no image: the entrypoint's `statusline`,
 * `.devcontainer/statusline.sh` through `sh`, and the Dockerfile's `NO_COLOR` for `bd` alone;
 * and the entrypoint's `clone`, against a local repository git reads as GitHub's address.
 */
import { spawn } from 'node:child_process'
import { createPrivateKey, createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRATCH_GIT_ENV } from '../tools/lib/git-env.ts'
import { copyPolicy, editPolicy, readPolicy } from '../tools/lib/policy.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.GITHUB_APP_TOKEN_ROOT ?? REPO_ROOT
const API = (process.env.GITHUB_APP_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
const NUMBER_KEYS = ['githubAppId', 'githubAppInstallationId', 'githubAppTokenRefreshSeconds']
// The keys Deploy leaves empty, all four together, for a project with no App.
const APP_KEYS = ['githubAppId', 'githubAppInstallationId', 'githubAppBotLogin', 'githubAppBotUserId']

// GitHub's own bounds on the JSON Web Token that asks for an installation token: `iat` set 60 s in
// the past against clock drift, and `exp` no more than ten minutes ahead, so `exp` is `iat` plus ten
// minutes (docs.github.com, "Generating a JSON Web Token (JWT) for a GitHub App", read 2026-10-06).
const JWT_BACKDATE_SECONDS = 60
const JWT_SPAN_SECONDS = 600
// The user name GitHub reads an installation token under over HTTPS ("Authenticating as a GitHub
// App installation", read 2026-10-06).
const GIT_USERNAME = 'x-access-token'

/** A refusal the command prints by its reason and exits 1 on, as opposed to a defect, which throws. */
class Refusal extends Error {}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** A canonical decimal id string becomes a number; all other values stay for the caller to refuse. */
const idNumber = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value

/** A project deployed with no App makes its changes on the host, so this refuses by that reason. */
function refuseNoApp(policy, root) {
  if (APP_KEYS.every((key) => policy[key] === '')) {
    throw new Refusal(`no GitHub App is set up: its keys are empty in policy/ under ${root}, so the container's git and gh cannot reach GitHub. Make changes on the host, where git and gh use your own account`)
  }
}

/** The four policy keys this reads: three whole numbers above 0 and a repository's bare name, or a refusal naming those that are not. */
function settings(root) {
  const policy = readPolicy(root)
  refuseNoApp(policy, root)
  policy.githubAppId = idNumber(policy.githubAppId)
  policy.githubAppInstallationId = idNumber(policy.githubAppInstallationId)
  const bad = NUMBER_KEYS.filter((key) => !Number.isSafeInteger(policy[key]) || policy[key] <= 0)
  if (bad.length > 0) {
    throw new Refusal(`${bad.map((key) => `\`${key}\``).join(', ')} must each be a whole number above 0 in policy/ under ${root}`)
  }
  const repository = policy.githubRepository
  if (typeof repository !== 'string' || !/^[\w.-]+$/.test(repository)) {
    throw new Refusal(`\`githubRepository\` must be a repository's bare name in policy/ under ${root}, not ${JSON.stringify(repository ?? null)}`)
  }
  return { appId: policy.githubAppId, installationId: policy.githubAppInstallationId, refreshSeconds: policy.githubAppTokenRefreshSeconds, repository }
}

/**
 * The App's bot account as git's commit identity: `githubAppBotLogin` as `user.name`, and the
 * noreply address GitHub gives an account, `<id>+<login>@users.noreply.github.com`, as `user.email`.
 * It needs no key and no token.
 */
function identity(root) {
  const policy = readPolicy(root)
  refuseNoApp(policy, root)
  const login = policy.githubAppBotLogin
  const id = idNumber(policy.githubAppBotUserId)
  if (typeof login !== 'string' || !/^[\w.-]+\[bot\]$/.test(login)) {
    throw new Refusal(`\`githubAppBotLogin\` must be a bot account's login, ending [bot], not ${JSON.stringify(login ?? null)} in policy/ under ${root}`)
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw new Refusal(`\`githubAppBotUserId\` must be a whole number above 0 in policy/ under ${root}`)
  return `user.name=${login}\nuser.email=${id}+${login}@users.noreply.github.com\n`
}

/** The App's private key: the one `.pem` file in `GITHUB_APP_KEY_DIR`. Its contents never reach a message. */
function readKey() {
  const dir = process.env.GITHUB_APP_KEY_DIR
  if (!dir) throw new Refusal("GITHUB_APP_KEY_DIR is not set: it names the directory holding the App's private key, which .devcontainer/devcontainer.json mounts read-only")
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    throw new Refusal(`cannot read the key directory ${dir}: ${error.code ?? error.message}`)
  }
  const pems = names.filter((name) => name.endsWith('.pem')).sort()
  if (pems.length !== 1) {
    throw new Refusal(`${dir} holds ${pems.length} .pem files${pems.length > 0 ? ` (${pems.join(', ')})` : ''}, where it must hold the App's one private key`)
  }
  const path = join(dir, pems[0])
  try {
    return createPrivateKey(readFileSync(path))
  } catch (error) {
    throw new Refusal(`${path} is not a private key Node can read: ${error.code ?? 'unreadable'}`)
  }
}

const base64url = (data) => Buffer.from(data).toString('base64url')

/** The JSON Web Token that asks GitHub for an installation token, signed RS256 as the App. */
function appJwt(key, appId) {
  const iat = nowSeconds() - JWT_BACKDATE_SECONDS
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ iat, exp: iat + JWT_SPAN_SECONDS, iss: appId }))
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key)
  return `${head}.${body}.${base64url(signature)}`
}

/**
 * A fresh installation token from GitHub, with the instant it expires, asked for the one repository
 * the policy names: without a body, a token reaches every repository the installation covers.
 */
async function mint({ appId, installationId, repository }) {
  const url = `${API}/app/installations/${installationId}/access_tokens`
  const headers = {
    Authorization: `Bearer ${appJwt(readKey(), appId)}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${repository}/github-app-token`,
  }
  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ repositories: [repository] }) })
  } catch (error) {
    throw new Refusal(`could not reach ${url}: ${error.cause?.code ?? error.message}`)
  }
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    // An answer that is not JSON is reported by its status and its first characters, below.
  }
  if (response.status !== 201) throw new Refusal(`GitHub answered ${response.status} to ${url}: ${body?.message ?? text.slice(0, 200)}`)
  // Described, never echoed: an answer with a token and a bad expiry would print the token.
  if (typeof body?.token !== 'string' || body.token === '' || Number.isNaN(Date.parse(body?.expires_at))) {
    const tokenSays = typeof body?.token === 'string' && body.token !== '' ? 'a token' : 'no token'
    throw new Refusal(`GitHub's answer from ${url} holds no token and expiry: ${tokenSays}, and expires_at ${JSON.stringify(body?.expires_at ?? null)}`)
  }
  return { token: body.token, expiresAt: body.expires_at }
}

/** Where the token is kept. */
function keptPath(installationId) {
  if (process.env.GITHUB_APP_TOKEN_CACHE) return process.env.GITHUB_APP_TOKEN_CACHE
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'github-app-token', `${installationId}.json`)
}

function readKept(path) {
  try {
    const kept = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof kept?.token === 'string' && !Number.isNaN(Date.parse(kept?.expiresAt))) return kept
  } catch {
    // None kept, or one that does not parse: either way a fresh one is minted.
  }
  return null
}

/** Keeps the token in a file of mode 600, in a directory of mode 700, written whole and renamed into place. */
function keep(path, kept) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const scratch = `${path}.${process.pid}.tmp`
  rmSync(scratch, { force: true })
  writeFileSync(scratch, `${JSON.stringify(kept)}\n`, { mode: 0o600 })
  renameSync(scratch, path)
}

/**
 * The kept token while it was minted for the repository the policy names and more than the refresh
 * margin of it is left, or else a fresh one, kept with that repository beside it.
 */
async function token(config) {
  const path = keptPath(config.installationId)
  const kept = readKept(path)
  if (kept?.repository === config.repository && Date.parse(kept.expiresAt) - Date.now() > config.refreshSeconds * 1000) return kept
  const fresh = { ...(await mint(config)), repository: config.repository }
  keep(path, fresh)
  return fresh
}

/** Git's credential attributes, `key=value` a line, up to a blank line or the end. */
function attributes(text) {
  const found = {}
  for (const line of text.split('\n')) {
    if (line === '') break
    const at = line.indexOf('=')
    if (at > 0) found[line.slice(0, at)] = line.slice(at + 1)
  }
  return found
}

async function stdinText() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

/**
 * One action of git's credential protocol. Anything but `https://github.com` gets no answer and
 * reads neither the policy nor the key, so git asks no further and the token goes nowhere else.
 */
async function gitCredential(action) {
  const asked = attributes(await stdinText())
  if (asked.protocol !== 'https' || asked.host !== 'github.com') return ''
  if (action === 'get') {
    const { token: secret, expiresAt } = await token(settings(ROOT))
    return `username=${GIT_USERNAME}\npassword=${secret}\npassword_expiry_utc=${Math.floor(Date.parse(expiresAt) / 1000)}\n`
  }
  if (action === 'erase') rmSync(keptPath(settings(ROOT).installationId), { force: true })
  // `store`, and any action git adds later, which a helper is to ignore.
  return ''
}

const USAGE = 'usage: node scripts/github-app-token.mjs token | git-credential <get|store|erase> | identity | --selftest'

async function main(argv) {
  const [command, action] = argv
  try {
    if (command === 'token' && argv.length === 1) {
      process.stdout.write(`${(await token(settings(ROOT))).token}\n`)
      return 0
    }
    if (command === 'git-credential' && action !== undefined && argv.length === 2) {
      process.stdout.write(await gitCredential(action))
      return 0
    }
    if (command === 'identity' && argv.length === 1) {
      process.stdout.write(identity(ROOT))
      return 0
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    console.error(`github-app-token: ${error.message}`)
    return 1
  }
  console.error(`github-app-token: ${USAGE}`)
  return 2
}

/* --------------------------------------------------------------------------------- selftest ----- */

/**
 * A stub of GitHub's endpoint on loopback. It records every request with the problems of its JSON
 * Web Token, checked against the public key and the App the live policy names, and answers as
 * `state.mode` says: `ok`, a token for an hour; `short`, one for a minute; `refuse`, a 401; `empty`,
 * a 201 with no token.
 */
function stubGitHub(publicKey, appId) {
  const state = { mode: 'ok', minted: 0, requests: [] }
  const server = createServer((request, response) => {
    let sent = ''
    request.on('data', (chunk) => (sent += chunk))
    request.on('end', () => {
      let repositories = null
      try {
        repositories = JSON.parse(sent).repositories ?? null
      } catch {
        // No body, or one that is not JSON: recorded as asking for no repository.
      }
      state.requests.push({ method: request.method, url: request.url, accept: request.headers.accept, repositories, problems: jwtProblems(request.headers.authorization, publicKey, appId) })
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (state.mode === 'refuse') return send(401, { message: 'A JSON web token could not be decoded' })
      if (state.mode === 'empty') return send(201, { expires_at: new Date(Date.now() + 3600_000).toISOString() })
      if (state.mode === 'bad-expiry') return send(201, { token: 'ghs_STUB_SECRET', expires_at: 'not-a-date' })
      state.minted += 1
      const life = state.mode === 'short' ? 60_000 : 3600_000
      return send(201, { token: `ghs_stub${state.minted}`, expires_at: new Date(Date.now() + life).toISOString() })
    })
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, state, url: `http://127.0.0.1:${server.address().port}` })))
}

/** What is wrong with a request's JSON Web Token, as GitHub would judge it: none, when GitHub would take it. */
function jwtProblems(authorization, publicKey, appId) {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? '')
  if (!match) return [`no Bearer JSON Web Token: ${authorization}`]
  const [, head, body, signature] = match
  const problems = []
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  let header
  let claims
  try {
    header = decode(head)
    claims = decode(body)
  } catch (error) {
    return [`the JSON Web Token does not decode: ${error.message}`]
  }
  if (header.alg !== 'RS256') problems.push(`alg ${header.alg}, not RS256`)
  if (!createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(signature, 'base64url'))) problems.push("the signature is not the App key's")
  const { iat, exp, iss } = claims
  const now = nowSeconds()
  if (String(iss) !== String(appId)) problems.push(`iss ${iss}, not the App ${appId}`)
  if (!(iat <= now)) problems.push(`iat ${iat} is after now, ${now}`)
  if (!(exp > now && exp <= now + JWT_SPAN_SECONDS)) problems.push(`exp ${exp} is not within ten minutes after now, ${now}`)
  if (!(exp - iat <= JWT_SPAN_SECONDS)) problems.push(`exp - iat is ${exp - iat}, over ten minutes`)
  return problems
}

/** A child process, run without blocking the stub it talks to: its status and what it printed. */
function run(command, args, { env, input = '', cwd = REPO_ROOT }) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', (error) => done({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (status) => done({ status, stdout, stderr }))
    // A child that exits before reading its input, as `token` and a refused run do, closes the
    // pipe: on Linux the write then fails with EPIPE, which threw and ended the whole run in CI
    // (verify on #165). Its status and output still say what the case asks, so EPIPE is no
    // problem; any other write error is reported with them.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stderr += `stdin: ${error.message}`
    })
    child.stdin.end(input)
  })
}

const GITHUB = 'protocol=https\nhost=github.com\n\n'
const DOCKERFILE = join(REPO_ROOT, '.devcontainer', 'Dockerfile')
const ENTRYPOINT = join(REPO_ROOT, '.devcontainer', 'entrypoint.sh')

/**
 * `.devcontainer/entrypoint.sh`'s `commit_identity`, run under bash with the file sourced for its
 * functions alone, against a `~/.gitconfig` of the case's own: `preset` writes keys into it first,
 * `workspace` is the clone the function runs the helper in. Returns the run, and the name and email
 * the file holds after it.
 */
async function commitIdentity(ctx, { workspace = REPO_ROOT, preset = [] } = {}) {
  const global = join(ctx.dir, 'gitconfig-identity')
  writeFileSync(global, '')
  const git = (args) => run('git', ['config', '--file', global, ...args], { env: SCRATCH_GIT_ENV, cwd: ctx.dir })
  for (const [key, value] of preset) await git([key, value])
  const r = await run('bash', ['-c', 'ENTRYPOINT_FUNCTIONS_ONLY=1 . "$1" && workspace="$2" && commit_identity', 'commit-identity', ENTRYPOINT, workspace], {
    env: { ...ctx.gitEnv, GIT_CONFIG_GLOBAL: global },
    cwd: ctx.dir,
  })
  return { r, name: (await git(['--get', 'user.name'])).stdout.trim(), email: (await git(['--get', 'user.email'])).stdout.trim() }
}

/**
 * `.devcontainer/entrypoint.sh`'s `statusline`, run under bash with the file sourced for its
 * functions alone and this checkout as the clone, against a `settings.json` of the case's own that
 * holds `content`. Returns the run, what the file holds after it, and whether a `.tmp` was left.
 */
async function statusLine(ctx, content) {
  const config = join(ctx.dir, 'claude')
  const settings = join(config, 'settings.json')
  mkdirSync(config, { recursive: true })
  writeFileSync(settings, content)
  const r = await run('bash', ['-c', 'ENTRYPOINT_FUNCTIONS_ONLY=1 . "$1" && workspace="$2" && statusline', 'statusline', ENTRYPOINT, REPO_ROOT], {
    env: { ...ctx.gitEnv, CLAUDE_CONFIG_DIR: config },
    cwd: ctx.dir,
  })
  return { r, after: readFileSync(settings, 'utf8'), tmp: existsSync(`${settings}.tmp`) }
}
const STATUS_LINE = { type: 'command', command: `sh '${join(REPO_ROOT, '.devcontainer', 'statusline.sh')}'` }

/**
 * `.devcontainer/entrypoint.sh`'s `clone`, run under bash with the file sourced for its functions
 * alone, into a workspace of the case's own, with the case's copy of the policy as the one the image
 * carries. git reads `https://github.com/` as a directory of the case's, where a repository with one
 * commit stands at the owner and name the policy gives, so no case reaches GitHub. `prepare` puts
 * something in the workspace first. Returns the run and the workspace.
 */
async function cloneStep(ctx, { prepare } = {}) {
  const policyFile = join(ctx.env.GITHUB_APP_TOKEN_ROOT, 'policy', 'tool-settings.json')
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'))
  const github = join(ctx.dir, 'github')
  const source = join(github, String(policy.githubRepositoryOwner), `${policy.githubRepository}.git`)
  mkdirSync(source, { recursive: true })
  await run('git', ['init', '-q'], { env: SCRATCH_GIT_ENV, cwd: source })
  await run('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'the source'], { env: SCRATCH_GIT_ENV, cwd: source })
  const workspace = join(ctx.dir, 'workspace')
  mkdirSync(workspace)
  if (prepare) await prepare(workspace)
  const r = await run('bash', ['-c', 'ENTRYPOINT_FUNCTIONS_ONLY=1 . "$1" && clone', 'clone', ENTRYPOINT], {
    env: {
      ...ctx.gitEnv,
      REPO_WORKSPACE: workspace,
      WORKSPACE_ENTRYPOINT_POLICY: policyFile,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${github}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    },
    cwd: ctx.dir,
  })
  return { r, workspace }
}
const headOf = (dir) => run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { env: SCRATCH_GIT_ENV, cwd: dir })
const IMAGE_BIN = '/usr/local/lib/github-app/bin/'

/**
 * The image's git config for github.com as the Dockerfile writes it: its `git config --system --add`
 * lines for `credential.` and `url.` keys, and the `GIT_CONFIG_*` variables its ENV lines set, with
 * the image's path of the wrappers read as this checkout's `.devcontainer/`, which the Dockerfile
 * copies there. Read from the Dockerfile, so a case run over it fails once a line it holds changes.
 */
function imageGitConfig() {
  const text = readFileSync(DOCKERFILE, 'utf8')
  const local = `${join(REPO_ROOT, '.devcontainer')}/`
  const unquote = (value) => value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
  const system = [...text.matchAll(/git config --system --add (\S+) ('[^']*'|"[^"]*"|\S+)/g)]
    .map(([, key, value]) => [key, unquote(value).replaceAll(IMAGE_BIN, local)])
    .filter(([key]) => /^(credential|url)\./.test(key))
  const env = {}
  for (const [, block] of text.matchAll(/^ENV ((?:[^\n]*\\\n)*[^\n]*)$/gm)) {
    for (const [, key, value] of block.replace(/\\\n/g, ' ').matchAll(/(GIT_CONFIG_\w+)=("[^"]*"|\S*)/g)) env[key] = unquote(value).replaceAll(IMAGE_BIN, local)
  }
  const copies = /^COPY \.devcontainer\/gh \.devcontainer\/git-credential-github-app \/usr\/local\/lib\/github-app\/bin\/$/m.test(text)
  return { system, env, copies }
}

/**
 * The environment of a git run under the image's config: its system lines as the system file, its
 * variables as given, and a global file whose helper stands for one a later scope adds, as VS Code's
 * does. That helper logs each action it is asked to a marker file, and answers `get` with the
 * maintainer's credential. Returns the environment and the marker, or the problem that stops it.
 */
async function imageGitEnv(ctx) {
  const { system, env, copies } = imageGitConfig()
  if (!copies) return { problem: `.devcontainer/Dockerfile no longer copies the two wrappers to ${IMAGE_BIN}` }
  if (system.length === 0 || env.GIT_CONFIG_COUNT === undefined) return { problem: `.devcontainer/Dockerfile holds ${system.length} git config line(s) for credential. or url., and ${env.GIT_CONFIG_COUNT === undefined ? 'no' : 'a'} GIT_CONFIG_COUNT` }
  const systemFile = join(ctx.dir, 'gitconfig-system')
  const globalFile = join(ctx.dir, 'gitconfig-global')
  const marker = join(ctx.dir, 'later-helper.log')
  writeFileSync(systemFile, '')
  writeFileSync(globalFile, '')
  const later = `!f() { echo "$1" >> '${marker}'; if [ "$1" = get ]; then printf 'username=maintainer\\npassword=MAINTAINER_PAT\\n'; fi; }; f`
  for (const [file, key, value] of [...system.map(([key, value]) => [systemFile, key, value]), [globalFile, 'credential.helper', later]]) {
    const r = await run('git', ['config', '--file', file, '--add', key, value], { env: SCRATCH_GIT_ENV, cwd: ctx.dir })
    if (r.status !== 0) return { problem: `git config --file could not write ${key}: ${r.stderr.trim()}` }
  }
  return { env: { ...ctx.gitEnv, ...env, GIT_CONFIG_SYSTEM: systemFile, GIT_CONFIG_GLOBAL: globalFile, GITHUB_APP_WORKSPACE: REPO_ROOT, GIT_TERMINAL_PROMPT: '0' }, marker }
}

/**
 * The cases. Each gets a fresh kept-token path and the stub reset to `ok`, then runs its steps
 * through `ctx`, and returns null when it holds or a sentence saying how it does not.
 */
function cases() {
  const helper = (ctx, args, extra = {}) => run(process.execPath, [SELF, ...args], { env: { ...ctx.env, ...extra.env }, input: extra.input ?? '' })
  const tokenRun = (ctx, extra) => helper(ctx, ['token'], extra)
  const get = (ctx, input = GITHUB, extra = {}) => helper(ctx, ['git-credential', 'get'], { ...extra, input })
  const said = (r) => `exited ${r.status}: ${`${r.stdout}${r.stderr}`.trim()}`
  const refused = (r, pattern, ctx, calls = 0) =>
    r.status === 1 && pattern.test(r.stderr) && r.stdout === '' && ctx.stub.requests.length === calls && !existsSync(ctx.kept) ? null : `${said(r)}, after ${ctx.stub.requests.length} call(s) to GitHub, ${existsSync(ctx.kept) ? 'a token kept' : 'none kept'}`
  return [
    {
      name: "control: `token` mints one token, signed as GitHub asks, for the App's installation, and keeps it where only its user reads it",
      check: async (ctx) => {
        const r = await tokenRun(ctx)
        const [call] = ctx.stub.requests
        if (r.status !== 0 || r.stdout !== 'ghs_stub1\n') return said(r)
        if (ctx.stub.requests.length !== 1) return `${ctx.stub.requests.length} calls to GitHub, not 1`
        if (call.method !== 'POST' || call.url !== `/app/installations/${ctx.installationId}/access_tokens`) return `called ${call.method} ${call.url}`
        if (!/application\/vnd\.github\+json/.test(call.accept ?? '')) return `asked for ${call.accept}`
        if (JSON.stringify(call.repositories) !== JSON.stringify([ctx.repository])) return `asked for the repositories ${JSON.stringify(call.repositories)}, not [${JSON.stringify(ctx.repository)}] alone`
        if (call.problems.length > 0) return `GitHub would refuse its JSON Web Token: ${call.problems.join('; ')}`
        if (readKept(ctx.kept)?.token !== 'ghs_stub1') return 'kept no token'
        if (process.platform !== 'win32' && (statSync(ctx.kept).mode & 0o077) !== 0) return `kept it with mode ${(statSync(ctx.kept).mode & 0o777).toString(8)}`
        return null
      },
    },
    {
      name: 'a kept token is handed out again with no call to GitHub',
      check: async (ctx) => {
        const first = await tokenRun(ctx)
        const second = await tokenRun(ctx)
        return first.stdout === 'ghs_stub1\n' && second.stdout === 'ghs_stub1\n' && ctx.stub.requests.length === 1 ? null : `${said(first)}; then ${said(second)}; ${ctx.stub.requests.length} calls`
      },
    },
    {
      name: 'a kept token with less than `githubAppTokenRefreshSeconds` left is replaced by a fresh one',
      check: async (ctx) => {
        ctx.stub.mode = 'short'
        const first = await tokenRun(ctx)
        ctx.stub.mode = 'ok'
        const second = await tokenRun(ctx)
        return first.stdout === 'ghs_stub1\n' && second.stdout === 'ghs_stub2\n' && ctx.stub.requests.length === 2 && readKept(ctx.kept)?.token === 'ghs_stub2'
          ? null
          : `${said(first)}; then ${said(second)}; ${ctx.stub.requests.length} calls`
      },
    },
    {
      name: 'a kept token minted for another repository, or before tokens named one, is replaced, though its hour has time left',
      check: async (ctx) => {
        const later = new Date(Date.now() + 3600_000).toISOString()
        for (const [index, kept] of [{ token: 'ghs_other', expiresAt: later, repository: 'another-repository' }, { token: 'ghs_unnamed', expiresAt: later }].entries()) {
          mkdirSync(dirname(ctx.kept), { recursive: true })
          writeFileSync(ctx.kept, `${JSON.stringify(kept)}\n`, { mode: 0o600 })
          const r = await tokenRun(ctx)
          if (r.stdout !== `ghs_stub${index + 1}\n`) return `handed out ${kept.token} where a fresh token was due: ${said(r)}`
        }
        return ctx.stub.requests.length === 2 ? null : `${ctx.stub.requests.length} calls to GitHub, not 2`
      },
    },
    {
      name: '`git-credential get` for https://github.com answers x-access-token, the token and its expiry',
      check: async (ctx) => {
        const r = await get(ctx)
        const expiry = Math.floor(Date.parse(readKept(ctx.kept)?.expiresAt) / 1000)
        return r.status === 0 && r.stdout === `username=x-access-token\npassword=ghs_stub1\npassword_expiry_utc=${expiry}\n` ? null : said(r)
      },
    },
    {
      name: '`git-credential get` for another host says nothing, calls nobody and reads no key',
      check: async (ctx) => {
        const r = await get(ctx, 'protocol=https\nhost=gitlab.com\n\n', { env: { GITHUB_APP_KEY_DIR: join(ctx.dir, 'no-such-directory') } })
        return r.status === 0 && r.stdout === '' && r.stderr === '' && ctx.stub.requests.length === 0 ? null : said(r)
      },
    },
    {
      name: '`git-credential get` for github.com over plain http says nothing',
      check: async (ctx) => {
        const r = await get(ctx, 'protocol=http\nhost=github.com\n\n')
        return r.status === 0 && r.stdout === '' && ctx.stub.requests.length === 0 ? null : said(r)
      },
    },
    {
      name: '`git-credential erase` drops the kept token, and the next `get` mints afresh',
      check: async (ctx) => {
        await tokenRun(ctx)
        const erase = await helper(ctx, ['git-credential', 'erase'], { input: `${GITHUB.trimEnd()}\nusername=x-access-token\npassword=ghs_stub1\n\n` })
        if (erase.status !== 0 || erase.stdout !== '' || existsSync(ctx.kept)) return `erase ${said(erase)}, ${existsSync(ctx.kept) ? 'the token still kept' : 'none kept'}`
        const r = await get(ctx)
        return /^password=ghs_stub2$/m.test(r.stdout) && ctx.stub.requests.length === 2 ? null : said(r)
      },
    },
    {
      name: '`git-credential erase` for another host leaves the kept token',
      check: async (ctx) => {
        await tokenRun(ctx)
        const erase = await helper(ctx, ['git-credential', 'erase'], { input: 'protocol=https\nhost=gitlab.com\n\n' })
        return erase.status === 0 && readKept(ctx.kept)?.token === 'ghs_stub1' ? null : `erase ${said(erase)}, ${existsSync(ctx.kept) ? 'a token kept' : 'none kept'}`
      },
    },
    {
      name: '`git-credential store` does nothing',
      check: async (ctx) => {
        await tokenRun(ctx)
        const store = await helper(ctx, ['git-credential', 'store'], { input: `${GITHUB.trimEnd()}\nusername=someone\npassword=another\n\n` })
        const r = await get(ctx)
        return store.status === 0 && store.stdout === '' && /^password=ghs_stub1$/m.test(r.stdout) && ctx.stub.requests.length === 1 ? null : `store ${said(store)}; then ${said(r)}`
      },
    },
    {
      name: 'GitHub refusing the token is refused, with its status and message, and nothing kept',
      check: async (ctx) => {
        ctx.stub.mode = 'refuse'
        return refused(await tokenRun(ctx), /GitHub answered 401 to .*: A JSON web token could not be decoded/, ctx, 1)
      },
    },
    {
      name: 'an answer from GitHub without a token is refused, and nothing kept',
      check: async (ctx) => {
        ctx.stub.mode = 'empty'
        return refused(await get(ctx), /GitHub's answer from .* holds no token and expiry/, ctx, 1)
      },
    },
    {
      name: 'an answer from GitHub with a token and an expiry that does not parse is refused, without printing the token',
      check: async (ctx) => {
        ctx.stub.mode = 'bad-expiry'
        const r = await tokenRun(ctx)
        return r.stderr.includes('ghs_STUB_SECRET') ? `printed the token: ${r.stderr.trim()}` : refused(r, /holds no token and expiry: a token, and expires_at "not-a-date"/, ctx, 1)
      },
    },
    {
      name: 'GitHub out of reach is refused, saying so',
      check: async (ctx) => refused(await tokenRun(ctx, { env: { GITHUB_APP_API_URL: ctx.closedUrl } }), /could not reach http:\/\/127\.0\.0\.1:\d+\/app\/installations\//, ctx),
    },
    {
      name: 'no GITHUB_APP_KEY_DIR is refused, calling nobody',
      check: async (ctx) => refused(await tokenRun(ctx, { env: { GITHUB_APP_KEY_DIR: '' } }), /GITHUB_APP_KEY_DIR is not set/, ctx),
    },
    {
      name: 'a key directory with no .pem is refused',
      check: async (ctx) => {
        const empty = join(ctx.dir, 'empty-keys')
        mkdirSync(empty)
        return refused(await tokenRun(ctx, { env: { GITHUB_APP_KEY_DIR: empty } }), /empty-keys holds 0 \.pem files, where it must hold the App's one private key/, ctx)
      },
    },
    {
      name: 'a key directory with two .pem files is refused, naming both',
      check: async (ctx) => {
        const two = join(ctx.dir, 'two-keys')
        mkdirSync(two)
        writeFileSync(join(two, 'a.pem'), ctx.pem)
        writeFileSync(join(two, 'b.pem'), ctx.pem)
        return refused(await tokenRun(ctx, { env: { GITHUB_APP_KEY_DIR: two } }), /two-keys holds 2 \.pem files \(a\.pem, b\.pem\)/, ctx)
      },
    },
    {
      name: 'a .pem that is not a private key is refused, without printing it',
      check: async (ctx) => {
        const bad = join(ctx.dir, 'bad-key')
        mkdirSync(bad)
        writeFileSync(join(bad, 'key.pem'), 'not-a-key-SECRET-TEXT\n')
        const r = await tokenRun(ctx, { env: { GITHUB_APP_KEY_DIR: bad } })
        return r.stderr.includes('SECRET-TEXT') ? `printed the file: ${r.stderr.trim()}` : refused(r, /key\.pem is not a private key Node can read/, ctx)
      },
    },
    {
      name: 'a policy without `githubAppId` is refused, naming it',
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubAppId),
      check: async (ctx) => refused(await tokenRun(ctx), /^github-app-token: `githubAppId` must each be a whole number above 0 in policy\//, ctx),
    },
    {
      name: 'a policy with every App key empty, as Deploy leaves a project with no App, is refused by that reason for `token` and `identity`',
      doctor: (root) => editPolicy(root, (policy) => { for (const key of APP_KEYS) policy[key] = '' }),
      check: async (ctx) => refused(await tokenRun(ctx), /^github-app-token: no GitHub App is set up: .* Make changes on the host/, ctx) ??
        refused(await helper(ctx, ['identity']), /^github-app-token: no GitHub App is set up/, ctx),
    },
    {
      name: 'a policy without `githubRepository` is refused, naming it, rather than mint a token for every repository',
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubRepository),
      check: async (ctx) => refused(await tokenRun(ctx), /`githubRepository` must be a repository's bare name in policy\/ under .*, not null/, ctx),
    },
    {
      name: 'a policy whose `githubAppTokenRefreshSeconds` is 0 is refused, naming it',
      doctor: (root) => editPolicy(root, (policy) => (policy.githubAppTokenRefreshSeconds = 0)),
      check: async (ctx) => refused(await tokenRun(ctx), /`githubAppTokenRefreshSeconds` must each be a whole number above 0/, ctx),
    },
    {
      name: 'decimal-string App ids mint the same token and print the same identity as numeric ids',
      doctor: (root) => editPolicy(root, (policy) => {
        for (const key of ['githubAppId', 'githubAppInstallationId', 'githubAppBotUserId']) policy[key] = String(policy[key])
      }),
      check: async (ctx) => {
        const token = await tokenRun(ctx)
        const identity = await helper(ctx, ['identity'])
        const [call] = ctx.stub.requests
        const want = `user.name=${ctx.botLogin}\nuser.email=${ctx.botUserId}+${ctx.botLogin}@users.noreply.github.com\n`
        return token.status === 0 && token.stdout === 'ghs_stub1\n' && ctx.stub.requests.length === 1 &&
          call.url === `/app/installations/${ctx.installationId}/access_tokens` && call.problems.length === 0 &&
          identity.status === 0 && identity.stdout === want ? null : `${said(token)}; ${said(identity)}`
      },
    },
    // Construct refusal fixtures at runtime so Deploy's substitution cannot fill them.
    ...['githubAppId', 'githubAppInstallationId', 'githubAppBotUserId'].flatMap((key) =>
      ['<REPLACE' + `_ME:${key}>`, '', '0', '-1', '1.5', '1e3', ' 123', '001', '9007199254740993'].map((value) => ({
        name: `${key} refuses the invalid id string ${JSON.stringify(value)}`,
        doctor: (root) => editPolicy(root, (policy) => (policy[key] = value)),
        check: async (ctx) => refused(
          await helper(ctx, [key === 'githubAppBotUserId' ? 'identity' : 'token']),
          new RegExp('`' + key + '` must (?:each be|be) a whole number above 0'),
          ctx,
        ),
      })),
    ),
    {
      name: "`identity` prints the App's bot account as user.name and its noreply address as user.email, calling nobody and reading no key",
      check: async (ctx) => {
        const r = await helper(ctx, ['identity'], { env: { GITHUB_APP_KEY_DIR: join(ctx.dir, 'no-such-directory') } })
        const want = `user.name=${ctx.botLogin}\nuser.email=${ctx.botUserId}+${ctx.botLogin}@users.noreply.github.com\n`
        return r.status === 0 && r.stdout === want && ctx.stub.requests.length === 0 ? null : `${said(r)}, not ${JSON.stringify(want)}`
      },
    },
    {
      name: '`identity` with a policy without `githubAppBotUserId` is refused, naming it',
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubAppBotUserId),
      check: async (ctx) => refused(await helper(ctx, ['identity']), /`githubAppBotUserId` must be a whole number above 0/, ctx),
    },
    {
      name: '`identity` with a policy without `githubAppBotLogin` is refused, naming it',
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubAppBotLogin),
      check: async (ctx) => refused(await helper(ctx, ['identity']), /`githubAppBotLogin` must be a bot account's login, ending \[bot\], not null/, ctx),
    },
    {
      name: '`identity` with a `githubAppBotLogin` that is not a bot\'s login is refused, naming it',
      doctor: (root) => editPolicy(root, (policy) => (policy.githubAppBotLogin = 'example-agent')),
      check: async (ctx) => refused(await helper(ctx, ['identity']), /`githubAppBotLogin` must be a bot account's login, ending \[bot\], not "example-agent"/, ctx),
    },
    {
      name: 'an unknown command prints the usage and exits 2',
      check: async (ctx) => {
        const r = await helper(ctx, ['mint'])
        return r.status === 2 && /usage: node scripts\/github-app-token\.mjs token/.test(r.stderr) && ctx.stub.requests.length === 0 ? null : said(r)
      },
    },
    {
      name: "real git, under the image's config as the Dockerfile writes it: GitHub's two SSH address forms, the first the one Dolt runs git against for the tracker's remote, read as HTTPS",
      wrapper: true,
      check: async (ctx) => {
        const image = await imageGitEnv(ctx)
        if (image.problem) return image.problem
        const urls = [
          ['ssh://git@github.com/example-owner/example-repo.git', 'https://github.com/example-owner/example-repo.git'],
          ['git@github.com:example-owner/example-repo.git', 'https://github.com/example-owner/example-repo.git'],
        ]
        for (const [from, to] of urls) {
          const r = await run('git', ['ls-remote', '--get-url', from], { env: image.env, cwd: ctx.dir })
          if (r.status !== 0 || r.stdout.trim() !== to) return `${from} read as ${said(r)}, not ${to}`
        }
        return null
      },
    },
    {
      name: "real git, under the image's config: `git credential fill` gets the App's token for github.com, and asks no helper a later scope adds",
      wrapper: true,
      check: async (ctx) => {
        const image = await imageGitEnv(ctx)
        if (image.problem) return image.problem
        const r = await run('git', ['credential', 'fill'], { env: image.env, input: GITHUB, cwd: ctx.dir })
        if (existsSync(image.marker)) return `asked the later scope's helper: ${readFileSync(image.marker, 'utf8').trim()}`
        return r.status === 0 && /^password=ghs_stub1$/m.test(r.stdout) ? null : said(r)
      },
    },
    {
      name: "real git, under the image's config: with the App unable to mint, git gets no credential, where a helper a later scope adds would hand it the maintainer's",
      wrapper: true,
      check: async (ctx) => {
        const image = await imageGitEnv(ctx)
        if (image.problem) return image.problem
        ctx.stub.mode = 'refuse'
        const r = await run('git', ['credential', 'fill'], { env: image.env, input: GITHUB, cwd: ctx.dir })
        if (r.stdout.includes('MAINTAINER_PAT')) return `git took the later scope's credential: ${said(r)}`
        if (existsSync(image.marker)) return `asked the later scope's helper: ${readFileSync(image.marker, 'utf8').trim()}`
        return r.status !== 0 ? null : said(r)
      },
    },
    {
      name: "real git, under the image's config: `git credential approve` hands the App's token to no helper a later scope adds",
      wrapper: true,
      check: async (ctx) => {
        const image = await imageGitEnv(ctx)
        if (image.problem) return image.problem
        const r = await run('git', ['credential', 'approve'], { env: image.env, input: `${GITHUB.trimEnd()}\nusername=x-access-token\npassword=ghs_stub1\n\n`, cwd: ctx.dir })
        if (existsSync(image.marker)) return `handed it to the later scope's helper, asked: ${readFileSync(image.marker, 'utf8').trim()}`
        return r.status === 0 ? null : said(r)
      },
    },
    {
      name: '.devcontainer/git-credential-github-app, named as the one helper by real git, gets the App\'s token for github.com',
      wrapper: true,
      check: async (ctx) => {
        const r = await run('git', ['-c', 'credential.helper=', '-c', `credential.helper=!sh '${join(REPO_ROOT, '.devcontainer', 'git-credential-github-app')}'`, 'credential', 'fill'], {
          env: { ...ctx.gitEnv, GITHUB_APP_WORKSPACE: REPO_ROOT },
          input: GITHUB,
          cwd: ctx.dir,
        })
        return r.status === 0 && /^username=x-access-token$/m.test(r.stdout) && /^password=ghs_stub1$/m.test(r.stdout) ? null : said(r)
      },
    },
    {
      name: '.devcontainer/git-credential-github-app, named the same way, gives another host nothing, so git has no password for it',
      wrapper: true,
      check: async (ctx) => {
        const r = await run('git', ['-c', 'credential.helper=', '-c', `credential.helper=!sh '${join(REPO_ROOT, '.devcontainer', 'git-credential-github-app')}'`, 'credential', 'fill'], {
          env: { ...ctx.gitEnv, GITHUB_APP_WORKSPACE: REPO_ROOT, GIT_TERMINAL_PROMPT: '0' },
          input: 'protocol=https\nhost=gitlab.com\n\n',
          cwd: ctx.dir,
        })
        return r.status !== 0 && !r.stdout.includes('ghs_stub') && ctx.stub.requests.length === 0 ? null : said(r)
      },
    },
    {
      name: "the entrypoint's commit_identity sets the App's bot account in a ~/.gitconfig with no email, through `identity` and the policy",
      wrapper: true,
      check: async (ctx) => {
        const { r, name, email } = await commitIdentity(ctx)
        const want = `${ctx.botUserId}+${ctx.botLogin}@users.noreply.github.com`
        return r.status === 0 && name === ctx.botLogin && email === want && r.stdout.includes(`committing as ${ctx.botLogin} <${want}>`) ? null : `${said(r)}; left ${name} <${email}>`
      },
    },
    {
      name: "the entrypoint's commit_identity leaves an email already in ~/.gitconfig, with its name, and logs nothing",
      wrapper: true,
      check: async (ctx) => {
        const { r, name, email } = await commitIdentity(ctx, { preset: [['user.name', 'A Person'], ['user.email', 'person@example.invalid']] })
        return r.status === 0 && name === 'A Person' && email === 'person@example.invalid' && !r.stdout.includes('committing as') ? null : `${said(r)}; left ${name} <${email}>`
      },
    },
    {
      name: "the entrypoint's commit_identity sets nothing, and warns, when `identity` refuses",
      wrapper: true,
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubAppBotUserId),
      check: async (ctx) => {
        const { r, name, email } = await commitIdentity(ctx)
        return name === '' && email === '' && /git identity unset, and the App's could not be read/.test(r.stdout) ? null : `${said(r)}; left ${name} <${email}>`
      },
    },
    {
      name: "the entrypoint's commit_identity warns when the clone's own config sets user.email, which outranks ~/.gitconfig",
      wrapper: true,
      check: async (ctx) => {
        const clone = join(ctx.dir, 'clone')
        mkdirSync(clone)
        await run('git', ['init', '-q'], { env: SCRATCH_GIT_ENV, cwd: clone })
        await run('git', ['config', '--local', 'user.email', 'me@work.example.invalid'], { env: SCRATCH_GIT_ENV, cwd: clone })
        symlinkSync(join(REPO_ROOT, 'scripts'), join(clone, 'scripts'))
        const { r, name } = await commitIdentity(ctx, { workspace: clone })
        return name === ctx.botLogin && /the clone's own \.git\/config sets user\.email, so commits here carry me@work\.example\.invalid, not the App's/.test(r.stdout) ? null : `${said(r)}; left the name ${name}`
      },
    },
    {
      name: "the entrypoint's statusline sets statusLine to the clone's .devcontainer/statusline.sh in a settings.json without one, and keeps its other keys",
      wrapper: true,
      check: async (ctx) => {
        const { r, after, tmp } = await statusLine(ctx, '{"model":"opus","theme":"dark"}')
        const want = `${JSON.stringify({ model: 'opus', theme: 'dark', statusLine: STATUS_LINE }, null, 2)}\n`
        return r.status === 0 && after === want && !tmp && /status line set in /.test(r.stdout) ? null : `${said(r)}; left ${JSON.stringify(after)}`
      },
    },
    {
      name: "the entrypoint's statusline sets statusLine in a settings.json of whitespace alone, rather than writing it empty",
      wrapper: true,
      check: async (ctx) => {
        const { r, after, tmp } = await statusLine(ctx, ' \n')
        return r.status === 0 && after === `${JSON.stringify({ statusLine: STATUS_LINE }, null, 2)}\n` && !tmp ? null : `${said(r)}; left ${JSON.stringify(after)}`
      },
    },
    {
      name: "the entrypoint's statusline leaves a settings.json that sets statusLine as it was, and logs nothing",
      wrapper: true,
      check: async (ctx) => {
        const content = '{"statusLine":{"type":"command","command":"true"},"model":"opus"}'
        const { r, after, tmp } = await statusLine(ctx, content)
        return r.status === 0 && after === content && !tmp && r.stdout === '' ? null : `${said(r)}; left ${JSON.stringify(after)}`
      },
    },
    {
      name: "the entrypoint's statusline leaves a settings.json jq cannot parse as it was, and warns",
      wrapper: true,
      check: async (ctx) => {
        const content = '{"model": "opus",'
        const { r, after, tmp } = await statusLine(ctx, content)
        return after === content && !tmp && /could not set the status line in .*is it valid JSON/.test(r.stdout) ? null : `${said(r)}; left ${JSON.stringify(after)}`
      },
    },
    {
      name: "the entrypoint's clone clones the repository the policy names into an empty workspace, and logs it",
      wrapper: true,
      check: async (ctx) => {
        const { r, workspace } = await cloneStep(ctx)
        const head = await headOf(workspace)
        return r.status === 0 && head.status === 0 && /cloning https:\/\/github\.com\/\S+ into /.test(r.stdout) ? null : `${said(r)}; HEAD ${head.status === 0 ? 'verifies' : 'does not verify'}`
      },
    },
    {
      name: "the entrypoint's clone leaves a workspace holding a clone with a commit as it was, and logs nothing",
      wrapper: true,
      check: async (ctx) => {
        const { r, workspace } = await cloneStep(ctx, {
          prepare: async (ws) => {
            await run('git', ['init', '-q'], { env: SCRATCH_GIT_ENV, cwd: ws })
            await run('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'a session'], { env: SCRATCH_GIT_ENV, cwd: ws })
            writeFileSync(join(ws, 'unpushed'), 'work')
          },
        })
        return r.status === 0 && r.stdout === '' && existsSync(join(workspace, 'unpushed')) ? null : said(r)
      },
    },
    {
      name: "the entrypoint's clone refuses a workspace whose .git holds no commit, a first start's clone left unfinished",
      wrapper: true,
      check: async (ctx) => {
        const { r } = await cloneStep(ctx, { prepare: (ws) => run('git', ['init', '-q'], { env: SCRATCH_GIT_ENV, cwd: ws }) })
        return r.status === 1 && /holds an unfinished clone, with no commit checked out/.test(r.stdout) ? null : said(r)
      },
    },
    {
      name: "the entrypoint's clone, with a policy without `githubRepositoryOwner`, clones nothing, warns and fails",
      wrapper: true,
      doctor: (root) => editPolicy(root, (policy) => delete policy.githubRepositoryOwner),
      check: async (ctx) => {
        const { r, workspace } = await cloneStep(ctx)
        return r.status === 1 && !existsSync(join(workspace, '.git')) && /cannot clone: .* names no githubRepositoryOwner and githubRepository/.test(r.stdout) ? null : said(r)
      },
    },
    {
      name: "the entrypoint's clone, with the template's placeholder as `githubRepositoryOwner`, clones nothing, warns and fails",
      wrapper: true,
      doctor: (root) => editPolicy(root, (policy) => (policy.githubRepositoryOwner = '<REPLACE' + '_ME:githubRepositoryOwner>')),
      check: async (ctx) => {
        const { r, workspace } = await cloneStep(ctx)
        return r.status === 1 && !existsSync(join(workspace, '.git')) && /cannot clone: .* names no githubRepositoryOwner and githubRepository/.test(r.stdout) ? null : said(r)
      },
    },
    {
      name: '.devcontainer/statusline.sh prints every field of a session through sh, which leaves a backslash in its JSON as it was',
      wrapper: true,
      check: async (ctx) => {
        // A newline inside a JSON string is the two characters `\n` in its text, which dash's `echo`,
        // the image's `sh`, would turn into a newline jq refuses, leaving every field empty.
        const session = {
          transcript_path: '/tmp/a\nb.jsonl',
          workspace: { project_dir: ctx.dir },
          model: { display_name: 'Opus 5.5' },
          effort: { level: 'high' },
          context_window: { remaining_percentage: 72.6, total_input_tokens: 54321 },
          cost: { total_cost_usd: 1.234 },
        }
        const r = await run('sh', [join(REPO_ROOT, '.devcontainer', 'statusline.sh')], { env: ctx.gitEnv, input: JSON.stringify(session), cwd: ctx.dir })
        const want = `${basename(ctx.dir)} | Opus 5.5 | effort:high | ctx:73% left | $1.23 | 54321 tok`
        return r.status === 0 && r.stdout === want ? null : `${said(r)}, not ${want}`
      },
    },
    {
      name: "the image sets NO_COLOR for no process but bd, by an alias in the interactive bash, since Claude Code shows no color while it is set",
      check: async () => {
        const text = readFileSync(DOCKERFILE, 'utf8')
        const env = [...text.matchAll(/^ENV ((?:[^\n]*\\\n)*[^\n]*)$/gm)].filter(([block]) => /\bNO_COLOR=/.test(block))
        const alias = /^RUN .*alias bd='NO_COLOR=1 bd'.*\/etc\/bash\.bashrc/m.test(text)
        return env.length === 0 && alias ? null : `${env.length} ENV line(s) set NO_COLOR for every process${alias ? '' : ', and no RUN line adds the bd alias to /etc/bash.bashrc'}`
      },
    },
    {
      name: '.devcontainer/gh runs the real gh with the token as GH_TOKEN, in the directory it was called from, with its arguments',
      wrapper: true,
      check: async (ctx) => {
        const r = await run('sh', [join(REPO_ROOT, '.devcontainer', 'gh'), 'pr', 'list', '--limit', '1'], { env: { ...ctx.gitEnv, ...ctx.ghEnv }, cwd: ctx.dir })
        return r.status === 0 && r.stdout === `ghs_stub1|${realpathSync(ctx.dir)}|pr list --limit 1\n` ? null : said(r)
      },
    },
    {
      name: '.devcontainer/gh runs no gh when no token can be minted, and prints why',
      wrapper: true,
      check: async (ctx) => {
        ctx.stub.mode = 'refuse'
        const r = await run('sh', [join(REPO_ROOT, '.devcontainer', 'gh'), 'pr', 'list'], { env: { ...ctx.gitEnv, ...ctx.ghEnv }, cwd: ctx.dir })
        return r.status !== 0 && r.stdout === '' && /GitHub answered 401/.test(r.stderr) ? null : said(r)
      },
    },
    {
      name: '.devcontainer/gh without GITHUB_APP_WORKSPACE runs no gh, and says what sets it',
      wrapper: true,
      check: async (ctx) => {
        const env = { ...ctx.gitEnv, ...ctx.ghEnv }
        delete env.GITHUB_APP_WORKSPACE
        const r = await run('sh', [join(REPO_ROOT, '.devcontainer', 'gh'), 'pr', 'list'], { env, cwd: ctx.dir })
        return r.status !== 0 && r.stdout === '' && /GITHUB_APP_WORKSPACE.*devcontainer\.json/.test(r.stderr) && ctx.stub.requests.length === 0 ? null : said(r)
      },
    },
  ]
}

/**
 * The App and repository the cases run against, in place of the identifiers a Target project sets
 * for itself. The Template's identifiers remain placeholders: no case depends on a real App or
 * reaches the project's own repository.
 */
const FIXTURE_APP = {
  githubAppId: 12345,
  githubAppInstallationId: 23456,
  githubAppBotLogin: 'example-agent[bot]',
  githubAppBotUserId: 34567,
  githubRepositoryOwner: 'example-owner',
  githubRepository: 'example-repo',
}

async function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'github-app-token-'))
  const results = []
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const stub = await stubGitHub(publicKey, FIXTURE_APP.githubAppId)
  // A port that nothing listens on: bound once, then let go.
  const closed = await new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(`http://127.0.0.1:${port}`))
    })
  })
  try {
    const keyDir = join(base, 'keys')
    mkdirSync(keyDir)
    writeFileSync(join(keyDir, 'app.private-key.pem'), pem, { mode: 0o600 })
    const env = { ...SCRATCH_GIT_ENV }
    for (const key of Object.keys(env)) if (key.startsWith('GITHUB_APP_')) delete env[key]
    let index = 0
    for (const { name, doctor, check, wrapper } of cases()) {
      index += 1
      if (wrapper && process.platform === 'win32') {
        results.push({ name, ok: true, detail: 'skipped: the wrappers are POSIX sh the Linux container runs, and this host is Windows' })
        continue
      }
      const dir = join(base, `case-${index}`)
      const root = join(dir, 'root')
      mkdirSync(root, { recursive: true })
      copyPolicy(REPO_ROOT, root)
      const copied = readPolicy(root)
      if (Object.entries(FIXTURE_APP).some(([key, value]) => copied[key] !== value)) {
        editPolicy(root, (policy) => Object.assign(policy, FIXTURE_APP))
      }
      if (doctor) doctor(root)
      const kept = join(dir, 'kept', 'token.json')
      Object.assign(stub.state, { mode: 'ok', minted: 0, requests: [] })
      const fakeGh = join(dir, 'gh')
      writeFileSync(fakeGh, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$GH_TOKEN" "$(pwd -P)" "$*"\n', { mode: 0o755 })
      const ctx = {
        dir,
        kept,
        pem,
        stub: stub.state,
        closedUrl: closed,
        installationId: FIXTURE_APP.githubAppInstallationId,
        repository: FIXTURE_APP.githubRepository,
        botLogin: FIXTURE_APP.githubAppBotLogin,
        botUserId: FIXTURE_APP.githubAppBotUserId,
        env: { ...env, GITHUB_APP_TOKEN_ROOT: root, GITHUB_APP_API_URL: stub.url, GITHUB_APP_KEY_DIR: keyDir, GITHUB_APP_TOKEN_CACHE: kept },
        gitEnv: { ...env, GITHUB_APP_TOKEN_ROOT: root, GITHUB_APP_API_URL: stub.url, GITHUB_APP_KEY_DIR: keyDir, GITHUB_APP_TOKEN_CACHE: kept, HOME: dir },
        ghEnv: { GITHUB_APP_WORKSPACE: REPO_ROOT, GITHUB_APP_REAL_GH: fakeGh },
      }
      let problem
      try {
        problem = await check(ctx)
      } catch (error) {
        problem = `threw ${error.name}: ${error.message}`
      }
      results.push({ name, ok: problem === null, detail: problem ?? 'holds' })
      if (name.startsWith('control') && problem !== null) {
        console.error(`selftest: the undoctored copy does not pass, so no case can be trusted: ${problem}`)
        return 1
      }
    }
  } finally {
    stub.server.close()
    rmSync(base, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  console.log(`github-app-token selftest: ${results.length - failed.length}/${results.length} cases hold, over a stubbed GitHub on loopback.`)
  return failed.length === 0 ? 0 : 1
}

// By real path: Node gives this module the resolved path of a symlink it was run through, which
// `process.argv[1]` keeps unresolved, and a match by name alone ran nothing, and exited 0, there.
const runAsMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
}
if (runAsMain()) {
  process.exitCode = process.argv[2] === '--selftest' && process.argv.length === 3 ? await selftest() : await main(process.argv.slice(2))
}

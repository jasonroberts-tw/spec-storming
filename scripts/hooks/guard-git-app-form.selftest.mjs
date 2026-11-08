/**
 * The host's App form of `gh pr create`, as the git guard's refusal names it, run with a token helper
 * that cannot mint. It is the protected test that reproduces ss-34a, so it holds only that defect's
 * cases; `worktree-hooks.selftest.mjs` holds the rest of the App rule's.
 *
 * THE FAILURE THIS PREVENTS. On 2026-11-08 the refusal of `scripts/hooks/guard-git.mjs` named
 * `GH_TOKEN="$(node scripts/github-app-token.mjs token)" gh pr create --base main ...` as the
 * host's form, and the guard allowed that form. When the helper cannot mint, it prints nothing and
 * exits 1. The shell still runs gh, with an empty GH_TOKEN, and gh ignores an empty GH_TOKEN and
 * runs as the login it has stored (`GH_TOKEN= gh auth status` named the keyring's login, gh 2.102.0,
 * 2026-11-07). So the pull request opens under the operator's login, which is the PR #4 incident the
 * App rule exists to stop.
 *
 * It reads the form from the refusal the guard gives a plain `gh pr create --base main`. It asserts
 * the guard allows that form. Then it runs the form through `sh` from this checkout's root, with a
 * stub `gh` first on PATH that records the GH_TOKEN it gets. The undoctored control mints from a
 * stub of GitHub's endpoint on loopback, and gh must run once with that token. Each other case
 * breaks the one thing its label names, and gh must never run with an empty token:
 * `GITHUB_APP_KEY_DIR` unset, GitHub out of reach, and GitHub refusing the JSON Web Token.
 *
 * The helper keeps its token in a file under the temporary directory (`GITHUB_APP_TOKEN_CACHE`),
 * never in the real cache. The runner's own tokens, `GITHUB_APP_*` settings and `GUARD_GIT_ROOT` are
 * dropped, so the guard reads this checkout's policy and only a case's own settings decide it.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-app-form.selftest.mjs)
 *
 * Needs Node, a POSIX `sh`, and this checkout's `policy/tool-settings.json`. It skips, saying why, on
 * Windows and under a policy that names no App, where the guard names no form. It binds a loopback
 * port and writes only under the temporary directory.
 */
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRUNK } from './_shared.mjs'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HOOKS, '..', '..')
const GUARD = join(HOOKS, 'guard-git.mjs')
const SETTINGS = JSON.parse(readFileSync(join(ROOT, 'policy', 'tool-settings.json'), 'utf8'))
const APP_KEYS = ['githubAppId', 'githubAppInstallationId', 'githubAppBotLogin', 'githubAppBotUserId']
const APP_TOKEN = 'ghs_STUB_APP_TOKEN'

if (process.platform === 'win32') {
  console.log('guard-git app form selftest: skipped, because the host form runs through a POSIX sh, which Windows lacks')
  process.exit(0)
}
if (APP_KEYS.every((key) => SETTINGS[key] === '')) {
  console.log('guard-git app form selftest: skipped, because policy/tool-settings.json names no App, so the guard names no form')
  process.exit(0)
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}

const DROPPED = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GUARD_GIT_ROOT'])
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !DROPPED.has(k) && !k.startsWith('GIT_') && !k.startsWith('GITHUB_APP_')),
)

/** A child process, run without blocking the stub GitHub it talks to, and killed after `RUN_MS`, as a form that never ends would be. */
const RUN_MS = 60_000
function run(command, args, { env, cwd }) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: RUN_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', (error) => done({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

/** A stub of GitHub's installation-token endpoint: `ok` answers a token for an hour, `refuse` a 401. */
function stubGitHub() {
  const state = { mode: 'ok', requests: 0 }
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      state.requests += 1
      const ok = state.mode === 'ok'
      response.writeHead(ok ? 201 : 401, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ok ? { token: APP_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() } : { message: 'A JSON web token could not be decoded' }))
    })
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, state, url: `http://127.0.0.1:${server.address().port}` })))
}

/** A loopback address nothing listens on: a port the system gave, then closed. */
function closedUrl() {
  const server = createServer()
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(`http://127.0.0.1:${port}`))
    }),
  )
}

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-app-form-'))
const bin = join(scratch, 'bin')
const keys = join(scratch, 'keys')
let stub = null

try {
  mkdirSync(bin)
  mkdirSync(keys)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n# a stub gh: it records the GH_TOKEN it runs with\nprintf \'%s\\n\' "${GH_TOKEN-<unset>}" >> "$STUB_GH_LOG"\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(join(keys, 'app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const PATH = [bin, process.env.PATH ?? ''].join(delimiter)

  /** guard-git on `command` typed from this checkout's root, with the stub gh first on PATH. */
  const guard = (command) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ cwd: ROOT, tool_input: { command } }),
      cwd: ROOT,
      env: { ...BASE_ENV, PATH },
      encoding: 'utf8',
    })
    return { code: r.status ?? 1, stderr: r.stderr ?? '' }
  }

  console.log("guard-git: the host's App form of gh pr create, with a helper that cannot mint")
  const refusal = guard(`gh pr create --base ${TRUNK} --fill`)
  const forms = refusal.stderr.split('`').filter((span, i) => i % 2 === 1 && `${span} `.includes(` pr create --base ${TRUNK} `))
  check(`the refusal of a plain create names one form of gh pr create --base ${TRUNK}`, refusal.code === 2 && forms.length === 1, `code=${refusal.code} ${JSON.stringify(refusal.stderr)}`)
  if (forms.length === 1) {
    const form = `${forms[0].replace(/\s*\.\.\.\s*$/, '')} --title t --body b`
    const allowed = guard(form)
    check(`the guard allows the form it names: ${form}`, allowed.code === 0, `code=${allowed.code} ${JSON.stringify(allowed.stderr.slice(0, 300))}`)

    stub = await stubGitHub()
    const unreachable = await closedUrl()
    let n = 0
    /** The form run through sh from this checkout's root: the GH_TOKEN of each gh it ran, and the run. */
    const runForm = async (settings) => {
      n += 1
      const log = join(scratch, `gh-${n}.log`)
      const env = { ...BASE_ENV, PATH, STUB_GH_LOG: log, GITHUB_APP_TOKEN_CACHE: join(scratch, `kept-${n}.json`), ...settings }
      const r = await run('sh', ['-c', form], { env, cwd: ROOT })
      const tokens = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1) : []
      return { tokens, said: `exit ${r.status}, gh ran with ${JSON.stringify(tokens)}; stderr ${JSON.stringify(r.stderr.trim().slice(0, 300))}` }
    }

    stub.state.mode = 'ok'
    const minted = await runForm({ GITHUB_APP_KEY_DIR: keys, GITHUB_APP_API_URL: stub.url })
    check(
      "control: with a helper that mints, the form runs gh once, with the App's token",
      minted.tokens.length === 1 && minted.tokens[0] === APP_TOKEN && stub.state.requests === 1,
      `${minted.said}; ${stub.state.requests} request(s) to the stub`,
    )

    for (const [label, settings, mode] of [
      ['GITHUB_APP_KEY_DIR unset', { GITHUB_APP_API_URL: stub.url }, 'ok'],
      ['GitHub out of reach', { GITHUB_APP_KEY_DIR: keys, GITHUB_APP_API_URL: unreachable }, 'ok'],
      ['GitHub refusing the JSON Web Token', { GITHUB_APP_KEY_DIR: keys, GITHUB_APP_API_URL: stub.url }, 'refuse'],
    ]) {
      stub.state.mode = mode
      const r = await runForm(settings)
      check(
        `with ${label}, the form runs no gh with an empty GH_TOKEN, which runs as the login gh has stored`,
        r.tokens.every((t) => t.trim() !== '' && t !== '<unset>'),
        r.said,
      )
    }
  }
} finally {
  if (stub !== null) stub.server.close()
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git app form selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git app form selftest: every case passed')

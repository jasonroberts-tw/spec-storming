/**
 * `scripts/gh`, the host's form of `gh pr create` that the git guard's refusal names, run through
 * `sh` from this checkout's root with a stub `gh` that records the GH_TOKEN it gets. The protected
 * `guard-git-app-form.selftest.mjs` holds only that no form runs gh with an empty token. This file
 * holds the rest, and is not protected.
 *
 * THE FAILURE THIS PREVENTS. The fresh-context review of ss-34a, on 2026-11-08, found two faults in
 * the first `scripts/gh`. It looked `gh` up on PATH by name, so with the clone's `scripts/` ahead of
 * the real gh, or an empty PATH entry while the session sat in `scripts/`, it ran itself without
 * end: a probe was killed after 3 s and 47 runs of the helper. And with an exported `CDPATH` that
 * resolved its relative path, `cd` printed the directory, the clone's path held two lines, and the
 * wrapper exited 1. The protected test also passed whatever stopped the mint, so a case could pass
 * for a reason other than its label's.
 *
 * Its cases, each against the control, which mints from a stub of GitHub's endpoint on loopback:
 *   - each way the mint fails runs no gh, and prints the helper's reason for that way;
 *   - the clone's `scripts/` first on PATH, an empty PATH entry while in `scripts/`, and an exported
 *     `CDPATH`, each run the stub gh once with the token;
 *   - with no gh on PATH but `scripts/gh` itself, it runs nothing and says so.
 * The helper keeps its token in a file under the temporary directory (`GITHUB_APP_TOKEN_CACHE`),
 * never in the real cache, and every run is killed after `RUN_MS`, so a wrapper that never ends
 * fails its case instead of hanging the run.
 *
 *   mise run worktree:selftest      (node scripts/hooks/guard-git-host-gh.selftest.mjs)
 *
 * Needs Node, a POSIX `sh` at /bin/sh, and this checkout's `policy/tool-settings.json`. It skips,
 * saying why, on Windows and under a policy that names no App. It binds a loopback port and writes
 * only under the temporary directory.
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
const HOST_GH = join(ROOT, 'scripts', 'gh')
const SETTINGS = JSON.parse(readFileSync(join(ROOT, 'policy', 'tool-settings.json'), 'utf8'))
const APP_KEYS = ['githubAppId', 'githubAppInstallationId', 'githubAppBotLogin', 'githubAppBotUserId']
const APP_TOKEN = 'ghs_STUB_APP_TOKEN'
const RUN_MS = 20_000

if (process.platform === 'win32') {
  console.log('guard-git host gh selftest: skipped, because scripts/gh is a POSIX sh script, which Windows does not run')
  process.exit(0)
}
if (APP_KEYS.every((key) => SETTINGS[key] === '')) {
  console.log('guard-git host gh selftest: skipped, because policy/tool-settings.json names no App, so the guard names no host form')
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

const DROPPED = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GUARD_GIT_ROOT', 'CDPATH'])
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !DROPPED.has(k) && !k.startsWith('GIT_') && !k.startsWith('GITHUB_APP_')),
)

/** A child process, run without blocking the stub GitHub it talks to, and killed after `RUN_MS`. */
function run(command, args, { env, cwd }) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: RUN_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', (error) => done({ status: null, stdout, stderr: `${stderr}${error.message}`, ms: Date.now() - started }))
    child.on('close', (status) => done({ status, stdout, stderr, ms: Date.now() - started }))
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

const scratch = mkdtempSync(join(tmpdir(), 'guard-git-host-gh-'))
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
  stub = await stubGitHub()
  const unreachable = await closedUrl()

  let n = 0
  /** `args` run through /bin/sh in `cwd`: the GH_TOKEN of each gh it ran, and the run. */
  const runSh = async (args, { cwd = ROOT, env = {} } = {}) => {
    n += 1
    const log = join(scratch, `gh-${n}.log`)
    const r = await run('/bin/sh', args, {
      cwd,
      env: { ...BASE_ENV, PATH, STUB_GH_LOG: log, GITHUB_APP_TOKEN_CACHE: join(scratch, `kept-${n}.json`), ...env },
    })
    const tokens = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1) : []
    return { ...r, tokens, said: `exit ${r.status} after ${r.ms} ms, gh ran with ${JSON.stringify(tokens)}; stderr ${JSON.stringify(r.stderr.trim().slice(0, 300))}` }
  }
  const MINTS = { GITHUB_APP_KEY_DIR: keys, GITHUB_APP_API_URL: stub.url }
  const ranOnceWithToken = (r) => r.status === 0 && r.tokens.length === 1 && r.tokens[0] === APP_TOKEN

  console.log("guard-git: the host's gh, scripts/gh, that the git guard's refusal names")
  const refusal = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: ROOT, tool_input: { command: `gh pr create --base ${TRUNK} --fill` } }),
    cwd: ROOT,
    env: { ...BASE_ENV, PATH },
    encoding: 'utf8',
  })
  const forms = (refusal.stderr ?? '').split('`').filter((span, i) => i % 2 === 1 && `${span} `.includes(` pr create --base ${TRUNK} `))
  check('the refusal of a plain create names scripts/gh as its one form', forms.length === 1 && forms[0].startsWith('scripts/gh '), JSON.stringify(refusal.stderr))
  const form = `${(forms[0] ?? `scripts/gh pr create --base ${TRUNK}`).replace(/\s*\.\.\.\s*$/, '')} --title t --body b`

  stub.state.mode = 'ok'
  const minted = await runSh(['-c', form], { env: MINTS })
  check("control: with a helper that mints, the form runs gh once, with the App's token", ranOnceWithToken(minted), minted.said)

  for (const [label, env, mode, reason] of [
    ['GITHUB_APP_KEY_DIR unset', { GITHUB_APP_API_URL: stub.url }, 'ok', /github-app-token: GITHUB_APP_KEY_DIR is not set/],
    ['GitHub out of reach', { GITHUB_APP_KEY_DIR: keys, GITHUB_APP_API_URL: unreachable }, 'ok', /github-app-token: could not reach http:\/\/127\.0\.0\.1:\d+\/app\/installations\//],
    ['GitHub refusing the JSON Web Token', MINTS, 'refuse', /github-app-token: GitHub answered 401 to .*: A JSON web token could not be decoded/],
  ]) {
    stub.state.mode = mode
    const r = await runSh(['-c', form], { env })
    check(`with ${label}, the form runs no gh, exits 1 and prints the helper's reason for it`, r.status === 1 && r.tokens.length === 0 && reason.test(r.stderr), r.said)
  }

  stub.state.mode = 'ok'
  const scripts = join(ROOT, 'scripts')
  const first = await runSh(['-c', form], { env: { ...MINTS, PATH: [scripts, PATH].join(delimiter) } })
  check("with the clone's scripts/ first on PATH, it skips itself and runs the stub gh once", ranOnceWithToken(first), first.said)
  const empty = await runSh([HOST_GH, 'pr', 'list'], { cwd: scripts, env: { ...MINTS, PATH: `${delimiter}${PATH}` } })
  check('with an empty PATH entry while in scripts/, it skips itself and runs the stub gh once', ranOnceWithToken(empty), empty.said)
  const cdpath = await runSh(['-c', form], { env: { ...MINTS, CDPATH: ROOT } })
  check('with an exported CDPATH that resolves its path, it still runs the stub gh once', ranOnceWithToken(cdpath), cdpath.said)
  const alone = await runSh([HOST_GH, 'pr', 'list'], { env: { ...MINTS, PATH: scripts } })
  check(
    'with no gh on PATH but itself, it runs nothing, exits 1 and says so',
    alone.status === 1 && alone.tokens.length === 0 && /scripts\/gh: no gh on PATH but this script/.test(alone.stderr),
    alone.said,
  )
} finally {
  if (stub !== null) stub.server.close()
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git host gh selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git host gh selftest: every case passed')

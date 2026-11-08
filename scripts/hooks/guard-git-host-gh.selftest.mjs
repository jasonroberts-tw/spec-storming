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
 * for a reason other than its label's. A second review, the same day, found two clones' `scripts/`
 * ahead of the real gh still looping, each wrapper running the other's (a probe was killed after
 * 3 s and 64 runs of the helper), and no case reaching the wrapper's branch for a `$0` with no slash.
 * A third review found that the second round's fix, a variable the wrapper exported, reached the
 * real gh and every process it started. A `scripts/gh` run inside that tree was refused, so a push
 * from `scripts/gh pr create` failed in the pre-push hook, where the protected selftest runs
 * `scripts/gh`. So two cases run `scripts/gh` from inside a gh that `scripts/gh` started.
 *
 * Its cases, each against the control, which mints from a stub of GitHub's endpoint on loopback:
 *   - each way the mint fails runs no gh, and prints the helper's reason for that way;
 *   - the clone's `scripts/` first on PATH, an empty PATH entry while in `scripts/`, an exported
 *     `CDPATH`, and `.devcontainer/gh` first on PATH as in the dev container, each run the stub gh
 *     once with the token;
 *   - under dash, which runs a bare `gh` found through an empty PATH entry with `$0` as `gh`, the
 *     same; where /bin/dash is missing the case is skipped, saying why;
 *   - with no gh on PATH but `scripts/gh` itself, or with another clone's `scripts/gh` next on PATH,
 *     it runs nothing and says so;
 *   - a gh that `scripts/gh` started runs `scripts/gh` by its path, which must run gh once with the
 *     token, and runs the protected `guard-git-app-form.selftest.mjs`, which must pass.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const DROPPED = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GUARD_GIT_ROOT', 'CDPATH', 'SCRIPTS_GH_RAN'])
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
  /** `args` run through `shell` in `cwd`: the GH_TOKEN of each gh it ran, and the run. */
  const runSh = async (args, { cwd = ROOT, env = {}, shell = '/bin/sh' } = {}) => {
    n += 1
    const log = join(scratch, `gh-${n}.log`)
    const r = await run(shell, args, {
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

  // A shell that finds a bare `gh` through an empty PATH entry runs it with `$0` as `gh`, with no
  // slash: dash does, while macOS's /bin/sh and bash give `./gh`. A probe in a directory of its own
  // shows the shell does so before the case leans on it.
  const DASH = '/bin/dash'
  if (existsSync(DASH)) {
    const probeDir = join(scratch, 'probe')
    mkdirSync(probeDir)
    writeFileSync(join(probeDir, 'gh'), '#!/bin/sh\nprintf \'%s\' "$0"\n')
    chmodSync(join(probeDir, 'gh'), 0o755)
    const probe = spawnSync(DASH, ['-c', 'gh'], { cwd: probeDir, env: { ...BASE_ENV, PATH: `${delimiter}${PATH}` }, encoding: 'utf8' })
    check('a probe: dash runs a gh it finds through an empty PATH entry with $0 as gh', probe.stdout === 'gh', JSON.stringify(probe.stdout))
    const bare = await runSh(['-c', 'gh pr list'], { cwd: scripts, shell: DASH, env: { ...MINTS, PATH: `${delimiter}${PATH}` } })
    check('found by dash as a bare gh in scripts/, with $0 holding no slash, it skips itself and runs the stub gh once', ranOnceWithToken(bare), bare.said)
  } else {
    console.log(`  skip $0 with no slash: ${DASH} is not installed, and /bin/sh here may give $0 a slash, so the case could not reach that branch`)
  }

  // Two clones' scripts/ ahead of the real gh: each wrapper would run the other's without end. The
  // second clone holds a copy of the wrapper and a link to this clone's helper, so it mints too.
  const other = join(scratch, 'other-clone')
  mkdirSync(join(other, 'scripts'), { recursive: true })
  writeFileSync(join(other, 'scripts', 'gh'), readFileSync(HOST_GH))
  chmodSync(join(other, 'scripts', 'gh'), 0o755)
  symlinkSync(join(ROOT, 'scripts', 'github-app-token.mjs'), join(other, 'scripts', 'github-app-token.mjs'))
  const twice = await runSh(['-c', form], { env: { ...MINTS, PATH: [scripts, join(other, 'scripts'), PATH].join(delimiter) } })
  check(
    "with another clone's scripts/ next on PATH, it runs nothing, exits 1 and names that clone's scripts/gh",
    twice.status === 1 &&
      twice.tokens.length === 0 &&
      twice.stderr.includes(`scripts/gh: ${join(realpathSync(other), 'scripts', 'gh')} on PATH, ahead of the real gh, is another clone's scripts/gh`),
    twice.said,
  )

  // A nested run: a gh that `scripts/gh` started runs `scripts/gh` again by its path, once, as a git
  // push from `gh pr create` reaches the pre-push hook. The inner run must run gh, so nothing the
  // outer run leaves in gh's environment may change how a later `scripts/gh` behaves.
  const nestBin = join(scratch, 'nest-bin')
  mkdirSync(nestBin)
  writeFileSync(
    join(nestBin, 'gh'),
    '#!/bin/sh\n# a stub gh: the first time, it runs scripts/gh by its path; then it records its GH_TOKEN\n' +
      'if [ -n "${STUB_GH_NEST-}" ]; then STUB_GH_NEST= exec "$STUB_GH_NEST" pr list; fi\n' +
      'printf \'%s\\n\' "${GH_TOKEN-<unset>}" >> "$STUB_GH_LOG"\n',
  )
  chmodSync(join(nestBin, 'gh'), 0o755)
  const nested = await runSh(['-c', form], { env: { ...MINTS, PATH: [nestBin, PATH].join(delimiter), STUB_GH_NEST: HOST_GH } })
  check('a scripts/gh run by its path from a gh that scripts/gh started runs gh, once, with the token', ranOnceWithToken(nested), nested.said)
  // The protected reproduction, run by a gh that scripts/gh started, as the pre-push hook runs it.
  const protectedTest = join(HOOKS, 'guard-git-app-form.selftest.mjs')
  const insideBin = join(scratch, 'inside-bin')
  mkdirSync(insideBin)
  const insideStatus = join(scratch, 'inside-status')
  writeFileSync(
    join(insideBin, 'gh'),
    `#!/bin/sh\n# a stub gh: it runs the protected app form selftest and records its exit status\nnode '${protectedTest}' > '${insideStatus}.out' 2>&1\necho $? > '${insideStatus}'\n`,
  )
  chmodSync(join(insideBin, 'gh'), 0o755)
  const inside = await runSh(['-c', form], { env: { ...MINTS, PATH: [insideBin, PATH].join(delimiter) } })
  const insideCode = existsSync(insideStatus) ? readFileSync(insideStatus, 'utf8').trim() : '<not run>'
  const insideOut = existsSync(`${insideStatus}.out`) ? readFileSync(`${insideStatus}.out`, 'utf8') : ''
  check(
    'guard-git-app-form.selftest.mjs passes when a gh that scripts/gh started runs it',
    inside.status === 0 && insideCode === '0',
    `${inside.said}; the selftest exited ${insideCode}: ${JSON.stringify(insideOut.split('\n').filter((line) => line.includes('FAIL')).join(' | ').slice(0, 300))}`,
  )
  // The dev container's hand-off: `.devcontainer/gh` first on PATH, which mints again and runs the real gh.
  const devBin = join(scratch, 'devcontainer-bin')
  mkdirSync(devBin)
  writeFileSync(join(devBin, 'gh'), readFileSync(join(ROOT, '.devcontainer', 'gh')))
  chmodSync(join(devBin, 'gh'), 0o755)
  const handOff = await runSh(['-c', form], {
    env: { ...MINTS, PATH: [devBin, PATH].join(delimiter), GITHUB_APP_WORKSPACE: ROOT, GITHUB_APP_REAL_GH: join(bin, 'gh') },
  })
  check('with .devcontainer/gh first on PATH, as in the dev container, it hands off and the stub gh runs once', ranOnceWithToken(handOff), handOff.said)
} finally {
  if (stub !== null) stub.server.close()
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-git host gh selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-git host gh selftest: every case passed')

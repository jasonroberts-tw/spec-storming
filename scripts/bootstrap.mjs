/**
 * Bootstrap: sets this machine up to work in this repository, running every setup step a program
 * can run, in order, on the host and in the dev container alike. It is the one home of those steps:
 * the README keeps only a person's steps, and the container's entrypoint calls this.
 *
 * THE FAILURE IT EXISTS TO PREVENT. The host's steps lived in the README and the container's in its
 * entrypoint, and the two drifted: a step one named and the other never ran left every machine of
 * that kind misconfigured, with nothing to say so.
 *
 *   mise run bootstrap                                   the host
 *   node scripts/bootstrap.mjs --container --warn-only   the entrypoint
 *   node scripts/bootstrap.mjs --dry-run                 each step it would take, changing nothing
 *   mise run bootstrap:selftest                          (--selftest) the steps over stub tools
 *
 * The steps, each checking first and doing nothing when nothing is needed, so a second run is cheap:
 *   1. the tools only a person installs: Git's floor, mise, and mise's node first on the PATH
 *      (the PATH check skipped with --container); a fail stops the run
 *   2. the toolchain: `mise install` when a pin is missing (skipped with --container: the image holds it)
 *   3. packages: `npm ci` when package-lock.json's hash differs from the last install's
 *   4. the git hooks, when an entry is missing
 *   5. the Tracker: `bd bootstrap` when it is not hydrated, never `bd init`
 *   6. plugins and installed skills: `scripts/skill-sources.mjs sync`
 *   7. the doctor, whose summary ends the run
 * A step that fails stops the run and exits 1; with --warn-only it prints the failure, goes on, and
 * exits 0, since nothing in the entrypoint may fail the container's start.
 *
 * It never edits a shell profile, trusts mise's config, logs in to Claude Code or places a secret:
 * each is a person's step, which the doctor reports. NEEDS Node and nothing from node_modules, since
 * it runs before `npm ci`. It changes the machine and reads the network, so it runs in neither the
 * pre-push hook nor CI; its selftest runs in both.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK_MARKER, format, personProbes } from './doctor.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const HOOK_EVENTS = ['pre-commit', 'prepare-commit-msg', 'post-checkout', 'post-merge', 'pre-push']

function env() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || key.startsWith('GIT_CONFIG_')))
}

/** Run a command in the checkout, its output passed through; throws, naming it, when it fails. */
function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: env(), stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` exited ${result.status}${quiet ? `: ${(result.stderr || result.stdout).trim()}` : ''}`)
  return result.stdout ?? ''
}

const lockHash = () => createHash('sha256').update(readFileSync(join(ROOT, 'package-lock.json'))).digest('hex')
const hookCommand = (event) => spawnSync('git', ['-C', ROOT, 'config', '--get', `hook.asdlc-${event}.command`], { env: env(), encoding: 'utf8' }).stdout.trim()

/**
 * bd 1.3.0 rewrites config.yaml without its final newline even when sync.remote is unchanged. Keep
 * the original bytes when only trailing newlines changed, so a fresh clone stays clean, and keep an
 * actual change bd made. The Template test reproduced the diff on 2026-10-12.
 */
function hydrateTracker() {
  const config = join(ROOT, '.beads/config.yaml')
  const saved = existsSync(config) ? readFileSync(config, 'utf8') : null
  try {
    run('bd', ['bootstrap'], { quiet: true })
  } finally {
    if (saved !== null && existsSync(config)) {
      const now = readFileSync(config, 'utf8')
      if (now !== saved && now.replace(/\n+$/, '') === saved.replace(/\n+$/, '')) writeFileSync(config, saved)
    }
  }
}

export function steps({ container = false, warnOnly = false } = {}) {
  return [
    {
      name: 'the tools a person installs',
      need: () => {
        const results = personProbes(ROOT, { container })
        for (const result of results.filter(([status]) => status !== 'ok')) console.log(format(result).replace('[doctor]', '[bootstrap]'))
        const failed = results.filter(([status]) => status === 'fail')
        if (failed.length) throw new Error(`${failed.map(([, , probe]) => probe).join('; ')} -- the lines above name the fix; it is a person's`)
        return null
      },
    },
    {
      name: 'the toolchain',
      skip: container && 'the image holds it; the doctor warns when it lags mise.toml',
      need: () => (run('mise', ['ls', '--current', '--missing', '--no-header'], { quiet: true }).trim() ? 'mise install' : null),
      act: () => run('mise', ['install']),
    },
    {
      name: 'packages',
      need: () => (existsSync(join(ROOT, 'package-lock.json')) && (existsSync(join(ROOT, LOCK_MARKER)) ? readFileSync(join(ROOT, LOCK_MARKER), 'utf8').trim() : null) !== lockHash() ? 'npm ci' : null),
      act: () => {
        run('npm', ['ci'])
        writeFileSync(join(ROOT, LOCK_MARKER), lockHash())
      },
    },
    {
      name: 'the git hooks',
      need: () => (HOOK_EVENTS.some((event) => hookCommand(event) !== `node scripts/git-hooks.mjs ${event}`) ? 'install the git hooks' : null),
      act: () => run(process.execPath, ['scripts/git-hooks.mjs', '--install'], { quiet: true }),
    },
    {
      name: 'the Tracker',
      need: () => (existsSync(join(ROOT, '.beads/embeddeddolt')) ? null : 'hydrate it with `bd bootstrap`'),
      act: hydrateTracker,
    },
    {
      name: 'plugins and installed skills',
      need: () => 'match them to policy/skill-sources.json',
      act: () => run(process.execPath, ['scripts/skill-sources.mjs', 'sync', ...(container ? ['--owns-user-config'] : []), ...(warnOnly ? ['--warn-only'] : [])]),
      dry: () => run(process.execPath, ['scripts/skill-sources.mjs', 'sync', '--dry-run']),
    },
    {
      name: 'the doctor',
      need: () => 'probe the result',
      act: () => run(process.execPath, ['scripts/doctor.mjs', ...(container ? ['--container'] : [])]),
    },
  ]
}

export function bootstrap({ container = false, warnOnly = false, dryRun = false } = {}) {
  let failed = false
  for (const [index, step] of steps({ container, warnOnly }).entries()) {
    const label = `[bootstrap] ${index + 1}. ${step.name}`
    try {
      if (step.skip) { console.log(`${label}: skipped, ${step.skip}`); continue }
      const need = step.need()
      if (!need || !step.act) { if (step.act || need) console.log(`${label}: nothing to do`); continue }
      if (dryRun) {
        console.log(`${label}: would ${need}`)
        step.dry?.()
        continue
      }
      console.log(`${label}: ${need}`)
      step.act()
    } catch (error) {
      console.log(`[bootstrap] fail ${step.name}: ${error.message}`)
      failed = true
      if (!warnOnly) return 1
    }
  }
  if (failed) console.log('[bootstrap] finished with failures, each above; run `mise run bootstrap` again once each is fixed')
  return 0
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest()
  process.exitCode = bootstrap({ container: argv.includes('--container'), warnOnly: argv.includes('--warn-only'), dryRun: argv.includes('--dry-run') })
}

// ---- selftest ---------------------------------------------------------------------------------

async function selftest() {
  const { test, after } = await import('node:test')
  const assert = (await import('node:assert/strict')).default
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-selftest-')))
  after(() => rmSync(temp, { recursive: true, force: true }))
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  let count = 0
  const log = (name) => `echo "${name} $*" >>"$STUB_LOG"`

  /** A fresh clone with stub mise, npm, bd, hook installer and sync on the PATH; `edit` changes it first. */
  function fixture(edit = () => {}) {
    const root = join(temp, `case-${++count}`)
    const bin = join(root, '.stub-bin')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, '.beads'))
    mkdirSync(bin)
    cpSync(SELF, join(root, 'scripts/bootstrap.mjs'))
    cpSync(join(dirname(SELF), 'doctor.mjs'), join(root, 'scripts/doctor.mjs'))
    cpSync(join(dirname(SELF), 'hooks/_shared.mjs'), join(root, 'scripts/hooks/_shared.mjs'))
    writeFileSync(join(root, 'scripts/git-hooks.mjs'), `const MIN_GIT = [2, 20, 0]
const { appendFileSync } = await import('node:fs'), { spawnSync } = await import('node:child_process')
appendFileSync(process.env.STUB_LOG, 'hooks ' + process.argv.slice(2).join(' ') + '\\n')
for (const e of ${JSON.stringify(HOOK_EVENTS)}) spawnSync('git', ['config', 'hook.asdlc-' + e + '.command', 'node scripts/git-hooks.mjs ' + e])
`)
    writeFileSync(join(root, 'scripts/skill-sources.mjs'), "const { appendFileSync } = await import('node:fs')\nappendFileSync(process.env.STUB_LOG, 'sync ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(Number(process.env.STUB_SYNC_EXIT ?? 0))\n")
    writeFileSync(join(root, 'scripts/github-app-token.mjs'), '')
    writeFileSync(join(root, 'mise.toml'), `[tools]\nnode = "${process.version.slice(1)}"\n`)
    writeFileSync(join(root, 'package-lock.json'), '{}\n')
    writeFileSync(join(root, '.beads/config.yaml'), 'sync.remote: "fixture"\n')
    writeFileSync(join(bin, 'mise'), `#!/bin/sh\n${log('mise')}\n[ "$1" = ls ] && printf "%s" "$STUB_MISE_MISSING"\nexit 0\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${log('npm')}\n[ -n "$STUB_NPM_FAILS" ] && exit 1\nmkdir -p node_modules\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'bd'), `#!/bin/sh\n${log('bd')}\n[ -n "$STUB_BD_NOOP" ] && exit 0\nmkdir -p .beads/embeddeddolt\neval "\${STUB_BD:-:}"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = --version ] && [ -n "$STUB_GIT_VERSION" ] && { echo "git version $STUB_GIT_VERSION"; exit 0; }\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
    // The doctor asks a login shell for node; the machine's own would find its node, not the pin (a CI runner's).
    writeFileSync(join(bin, 'login-shell'), `#!/bin/sh\necho ${process.version}\n`, { mode: 0o755 })
    const environment = {
      ...env(), PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), SHELL: join(bin, 'login-shell'),
      GIT_CONFIG_GLOBAL: join(root, '.gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', STUB_LOG: join(bin, 'log'),
    }
    spawnSync('git', ['init', '--quiet', root], { env: environment })
    writeFileSync(environment.STUB_LOG, '')
    edit({ root, env: environment })
    return {
      root,
      bootstrap: (...args) => spawnSync(process.execPath, [join(root, 'scripts/bootstrap.mjs'), ...args], { cwd: root, env: environment, encoding: 'utf8' }),
      log: () => { const text = readFileSync(environment.STUB_LOG, 'utf8'); writeFileSync(environment.STUB_LOG, ''); return text },
      config: () => readFileSync(join(root, '.beads/config.yaml'), 'utf8'),
    }
  }
  const out = (r) => r.stdout + r.stderr

  test('control: a fresh clone gets npm ci, the hooks, the Tracker, the sync and a clean doctor; a second run does only the sync and the doctor', () => {
    const f = fixture()
    let r = f.bootstrap()
    assert.equal(r.status, 0, out(r))
    assert.deepEqual(f.log().split('\n').filter((l) => !l.startsWith('mise')), ['npm ci', 'hooks --install', 'bd bootstrap', 'sync sync', 'sync sync --dry-run', ''])
    assert.match(r.stdout, /\[doctor\] \d+ ok, 0 warn, 0 fail/)
    assert.equal(f.config(), 'sync.remote: "fixture"\n')
    r = f.bootstrap()
    assert.equal(r.status, 0, out(r))
    assert.deepEqual(f.log().split('\n').filter((l) => !l.startsWith('mise')), ['sync sync', 'sync sync --dry-run', ''])
    assert.match(r.stdout, /3\. packages: nothing to do/)
  })
  test('installs a missing pin on the host, and leaves the toolchain to the image in the container', () => {
    const f = fixture(({ env: e }) => { e.STUB_MISE_MISSING = 'gh 2.102.0' })
    f.bootstrap()
    assert.match(f.log(), /^mise install$/m)
    const r = f.bootstrap('--container', '--warn-only')
    assert.doesNotMatch(f.log(), /^mise install$/m)
    assert.match(r.stdout, /2\. the toolchain: skipped/)
  })
  test('--container passes --owns-user-config to the sync and --container to the doctor', () => {
    const f = fixture()
    const r = f.bootstrap('--container')
    assert.equal(r.status, 0, out(r))
    assert.match(f.log(), /^sync sync --owns-user-config$/m)
    assert.match(r.stdout, /container: the GitHub App mints a token/)
  })
  test('a person\'s missing tool stops the run before any change, and --warn-only goes on', () => {
    const f = fixture(({ env: e }) => { e.STUB_GIT_VERSION = '2.1.0' })
    let r = f.bootstrap()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /\[bootstrap\] fail toolchain: git is 2\.20\.0 or later -- git is 2\.1\.0/)
    assert.match(r.stdout, /\[bootstrap\] fail the tools a person installs: git is 2\.20\.0 or later/)
    assert.doesNotMatch(f.log(), /npm ci/)
    r = f.bootstrap('--warn-only')
    assert.equal(r.status, 0, out(r))
    assert.match(f.log(), /npm ci/)
  })
  test('a failing npm ci stops the run and records no install, and --warn-only goes on and exits 0', () => {
    const f = fixture(({ env: e }) => { e.STUB_NPM_FAILS = '1' })
    let r = f.bootstrap()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /\[bootstrap\] fail packages: `npm ci` exited 1/)
    assert.ok(!existsSync(join(f.root, LOCK_MARKER)))
    assert.doesNotMatch(f.log(), /hooks --install/)
    r = f.bootstrap('--warn-only')
    assert.equal(r.status, 0, out(r))
    assert.match(f.log(), /hooks --install/)
    assert.match(r.stdout, /finished with failures/)
  })
  test('a sync that fails fails the run', () => {
    const f = fixture(({ env: e }) => { e.STUB_SYNC_EXIT = '1' })
    const r = f.bootstrap()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /\[bootstrap\] fail plugins and installed skills: `.*skill-sources\.mjs sync` exited 1/)
  })
  test('a doctor that finds a fail fails the run', () => {
    const f = fixture(({ env: e }) => { e.STUB_BD_NOOP = '1' })
    const r = f.bootstrap()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /\[doctor\] fail tracker: the Tracker is hydrated/)
    assert.match(r.stdout, /\[bootstrap\] fail the doctor/)
  })
  test('the Tracker\'s config keeps its final newline when bd strips it, and keeps a real change bd made', () => {
    const stripped = fixture(({ env: e }) => { e.STUB_BD = `printf 'sync.remote: "fixture"' >.beads/config.yaml` })
    stripped.bootstrap()
    assert.equal(stripped.config(), 'sync.remote: "fixture"\n')
    const changed = fixture(({ env: e }) => { e.STUB_BD = `printf 'sync.remote: "changed"' >.beads/config.yaml` })
    changed.bootstrap()
    assert.equal(changed.config(), 'sync.remote: "changed"')
  })
  test('--dry-run prints each step it would take and changes nothing', () => {
    const f = fixture()
    const r = f.bootstrap('--dry-run')
    assert.equal(r.status, 0, out(r))
    assert.match(r.stdout, /3\. packages: would npm ci/)
    assert.match(r.stdout, /5\. the Tracker: would hydrate it/)
    assert.deepEqual(f.log().split('\n').filter((l) => /^(npm|bd|hooks)/.test(l)), [])
    assert.ok(!existsSync(join(f.root, 'node_modules')) && !existsSync(join(f.root, '.beads/embeddeddolt')))
  })
}

if (process.argv[1] && realpathSync(process.argv[1]) === SELF) await main(process.argv.slice(2))

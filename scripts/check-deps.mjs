/**
 * Dependency gate. It hands osv-scanner every tracked file. osv-scanner reads the ones it knows as a
 * lockfile or manifest (`package-lock.json`, `requirements.txt`, `go.mod`, `Cargo.lock` and the rest
 * it supports), and the gate refuses every package version that has a known vulnerability on
 * osv.dev. A repository with no such file skips clean, and says so.
 *
 * It names the files rather than letting osv-scanner walk the tree. That walk applies every
 * `.gitignore` from `/` down, the ones above the repository too, so in a linked worktree under
 * `.claude/worktrees/`, which the primary checkout's `.gitignore` lists, it finds no file, and reports
 * no package. A named file is read whatever the ignores say, and naming only tracked files leaves
 * `node_modules/` and other worktrees unread. The names go in batches that keep each command line
 * under Windows' limit. It reads the working tree's copy of each tracked file, as every gate here does.
 *
 * A finding that does not apply is accepted in an `osv-scanner.toml` beside the lockfile, which
 * osv-scanner reads itself: an `[[IgnoredVulns]]` entry with the advisory's `id`, a `reason`, and an
 * `ignoreUntil` date, after which the finding fails the gate again.
 *
 * A new advisory can land against a lockfile nobody changed. The pre-push job runs only when a
 * lockfile changes, so it misses that advisory; the CI step runs on every pull request, and finds it.
 *
 * THE FAILURE IT EXISTS TO PREVENT. No incident yet: the gate came with the scanner, and its first
 * run refused the Template's own lockfile, whose `qs` 6.15.1 carried three advisories. Were this gate
 * wrong, a dependency with a published advisory would merge unnoticed: every push from an agent's
 * worktree would pass, if it let osv-scanner walk the tree and read "no package found" as nothing to
 * check; and every push made offline would pass, if it read a failed query to osv.dev as a skip.
 *
 * INVOCATION.
 *
 *   mise run deps:check                          every tracked lockfile and manifest, against osv.dev
 *   mise run deps:selftest                       (--selftest) each refusal and skip, offline, over scratch repositories
 *   DEPS_CHECK_ROOT=<dir> mise run deps:check    the same gate over a doctored copy
 *
 * NEEDS osv-scanner, which `mise.toml` pins and `mise run` puts on the PATH; Git; and the network:
 * osv.dev, and deps.dev for the manifests whose transitive dependencies osv-scanner resolves, such as
 * `pom.xml`. An unreachable osv.dev fails the gate, as any failure of a tool that was found does. Its
 * selftest needs no network: it builds a local database of one advisory and points the failure case
 * at a proxy that refuses every connection. 0.82 s wall for the gate over 223 packages and 20.5 s
 * for its selftest through `mise run` (`/usr/bin/time -p`, one run each) on a macOS laptop with
 * osv-scanner 2.6.0, 2026-10-16; 17 s of the selftest is osv-scanner's four attempts at the refusing
 * proxy, the price of testing the failure a real push meets offline.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { gitEnv, gitIn, SCRATCH_GIT_ENV } from '../tools/lib/git-env.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.DEPS_CHECK_ROOT ? resolve(process.env.DEPS_CHECK_ROOT) : REPO_ROOT
// Windows holds a command line to 32,767 characters; this leaves room for osv-scanner's path and flags.
const COMMAND_LINE_BUDGET = 24_000
// osv-scanner's exit when no file it was given is one it reads.
const NO_PACKAGE_FOUND = 128
const tail = (text) => (text ?? '').trim().split('\n').slice(-5).join(' | ')

/** `files`, in runs whose joined length stays inside one command line. */
function batches(files) {
  const out = [[]]
  let length = 0
  for (const file of files) {
    if (length + file.length + 1 > COMMAND_LINE_BUDGET && out.at(-1).length > 0) {
      out.push([])
      length = 0
    }
    out.at(-1).push(file)
    length += file.length + 1
  }
  return out
}

/** What osv-scanner finds in the tracked files under `root`: `pass`, `skip` or `fail`, with the lines that say why. */
function runCheck(root, { args = [], env = {} } = {}) {
  let files
  try {
    files = gitIn(root)(['ls-files', '-z']).split('\0').filter((file) => file && existsSync(join(root, file)))
  } catch (error) {
    return { status: 'fail', lines: [`the tracked files under ${root} are unknown: ${error.message}`] }
  }
  const packages = []
  const findings = []
  let sources = 0
  for (const batch of batches(files)) {
    const run = spawnSync('osv-scanner', ['scan', 'source', '--format=json', '--all-packages', ...args, '--', ...batch], {
      cwd: root,
      env: { ...gitEnv(), ...env },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    if (run.error) return { status: 'fail', lines: [`osv-scanner could not start (${run.error.message}); run the gate through \`mise run\`, which puts the pinned osv-scanner on the PATH`] }
    if (run.status === NO_PACKAGE_FOUND) continue
    let report = null
    try {
      report = JSON.parse(run.stdout)
    } catch {}
    // An unreachable osv.dev still prints a report, an empty one, so the exit decides first.
    if ((run.status !== 0 && run.status !== 1) || !Array.isArray(report?.results)) {
      return { status: 'fail', lines: [`osv-scanner exited ${run.status}, so the dependencies were not checked: ${tail(run.stderr)}`] }
    }
    const before = findings.length
    for (const result of report.results) {
      sources++
      // osv-scanner names a file by its real path, which differs where the root's path has a symlink.
      const file = relative(realpathSync(root), resolve(root, result.source.path))
      for (const { package: pkg, groups = [], vulnerabilities = [] } of result.packages ?? []) {
        packages.push(pkg)
        if (vulnerabilities.length === 0) continue
        const ids = groups.length > 0 ? groups.map((group) => group.ids.join('/')) : vulnerabilities.map((v) => v.id)
        findings.push(`${file}: ${pkg.ecosystem} ${pkg.name}@${pkg.version}: ${ids.join(', ')}`)
      }
    }
    if (run.status === 1 && findings.length === before) {
      return { status: 'fail', lines: [`osv-scanner exited 1 and reported no vulnerable package, so its result is unknown: ${tail(run.stderr)}`] }
    }
  }
  if (findings.length > 0) return { status: 'fail', lines: findings }
  if (sources === 0) return { status: 'skip', lines: [`none of the ${files.length} tracked file(s) is a lockfile or manifest osv-scanner reads, so nothing to check`] }
  return { status: 'pass', lines: [`${packages.length} package(s) in ${sources} file(s), and no known vulnerability`] }
}

function main() {
  const { status, lines } = runCheck(ROOT)
  if (status === 'fail') {
    console.error(`deps: refused, ${lines.length} problem(s).\n`)
    for (const line of lines) console.error(`  - ${line}`)
    console.error('\nMove each package to a version osv.dev names as fixed, or accept an advisory in an `osv-scanner.toml` beside its lockfile, with a reason and an `ignoreUntil` date.')
    process.exit(1)
  }
  console.log(`deps: ${status === 'skip' ? 'skipped, ' : ''}${lines[0]}.`)
}

/* --------------------------------------------------------------------------------- selftest ----- */

const ADVISORY = 'OSV-SELFTEST-1'
const PACKAGE = 'selftest-vulnerable'

/** A zip of `files` ({ name: text }), stored uncompressed: all osv-scanner's local database reader needs. */
function zip(files) {
  const parts = []
  const directory = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const path = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(33, 12) // 1980-01-01, the first date a zip can hold
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE(offset, 42)
    parts.push(local, path, data)
    directory.push(central, path)
    offset += local.length + path.length + data.length
  }
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(listing.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, listing, end])
}

/** osv-scanner's local database, holding one advisory: every version of the fixture package below 1.0.1. */
function database(base) {
  const advisory = {
    schema_version: '1.6.0',
    id: ADVISORY,
    modified: '2026-10-16T00:00:00Z',
    summary: 'A fixture advisory for the dependency gate selftest',
    affected: [{ package: { ecosystem: 'npm', name: PACKAGE }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }],
  }
  // `osv-scalibr/`, which osv-scanner 2.6.0 reads, and not the `osv-scanner/` its offline-mode
  // documentation names; a move of it fails the control, which names its package count.
  const dir = join(base, 'db')
  mkdirSync(join(dir, 'osv-scalibr/npm'), { recursive: true })
  writeFileSync(join(dir, 'osv-scalibr/npm/all.zip'), zip({ [`${ADVISORY}.json`]: JSON.stringify(advisory) }))
  return dir
}

/** A package-lock.json holding the fixture package at `version` and one package no advisory names. */
const lockfile = (version) =>
  `${JSON.stringify(
    {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', dependencies: { [PACKAGE]: version, 'selftest-clean': '2.0.0' } },
        [`node_modules/${PACKAGE}`]: { version },
        'node_modules/selftest-clean': { version: '2.0.0' },
      },
    },
    null,
    2,
  )}\n`

/** A port nothing listens on, for a proxy that refuses every connection. */
async function closedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

/** Each case is a scratch repository: `tracked` files committed, `untracked` ones beside them. */
function cases(port) {
  const offline = { args: ['--offline'] }
  const refused = `http://127.0.0.1:${port}`
  return [
    { name: 'control: a lockfile with no vulnerable version', tracked: { 'package-lock.json': lockfile('1.0.1') }, expect: /^2 package\(s\) in 1 file\(s\), and no known vulnerability$/ },
    { name: 'a vulnerable version', tracked: { 'package-lock.json': lockfile('1.0.0') }, refuse: /^package-lock\.json: npm selftest-vulnerable@1\.0\.0: OSV-SELFTEST-1$/ },
    { name: 'a vulnerable version in a subdirectory', tracked: { 'package-lock.json': lockfile('1.0.1'), 'app/package-lock.json': lockfile('1.0.0') }, refuse: /^app\/package-lock\.json: npm selftest-vulnerable@1\.0\.0: OSV-SELFTEST-1$/ },
    {
      name: 'a repository under a directory an ancestor .gitignore lists, as a linked worktree is',
      ignoredBy: 'inner/',
      tracked: { 'package-lock.json': lockfile('1.0.0') },
      refuse: /^package-lock\.json: npm selftest-vulnerable@1\.0\.0: OSV-SELFTEST-1$/,
    },
    {
      name: 'an untracked lockfile is not read',
      tracked: { 'package-lock.json': lockfile('1.0.1') },
      untracked: { 'node_modules/stray/package-lock.json': lockfile('1.0.0') },
      expect: /^2 package\(s\) in 1 file\(s\), and no known vulnerability$/,
    },
    {
      name: 'an advisory accepted in osv-scanner.toml',
      tracked: {
        'package-lock.json': lockfile('1.0.0'),
        'osv-scanner.toml': `[[IgnoredVulns]]\nid = "${ADVISORY}"\nignoreUntil = 2099-01-01\nreason = "a fixture's accepted finding"\n`,
      },
      expect: /^2 package\(s\) in 1 file\(s\), and no known vulnerability$/,
    },
    { name: 'no lockfile skips clean, and says so', tracked: { 'README.md': '# fixture\n' }, skip: /^none of the 1 tracked file\(s\) is a lockfile or manifest osv-scanner reads, so nothing to check$/ },
    {
      name: 'an unreachable osv.dev fails, and is no skip',
      online: { HTTPS_PROXY: refused, https_proxy: refused, HTTP_PROXY: refused, http_proxy: refused, NO_PROXY: '', no_proxy: '' },
      tracked: { 'package-lock.json': lockfile('1.0.1') },
      refuse: /^osv-scanner exited 127, so the dependencies were not checked: .*api\.osv\.dev/,
    },
  ].map((c) => ({ ...c, mode: c.online ? { env: c.online } : offline }))
}

const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-')

function fixture(base, { name, tracked, untracked = {}, ignoredBy }) {
  let dir = join(base, slug(name))
  mkdirSync(dir, { recursive: true })
  if (ignoredBy) {
    writeFileSync(join(dir, '.gitignore'), `${ignoredBy}\n`)
    dir = join(dir, ignoredBy)
    mkdirSync(dir)
  }
  const git = gitIn(dir, SCRATCH_GIT_ENV)
  git(['init', '-q', '-b', 'main'])
  const put = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  put(tracked)
  git(['add', '--', ...Object.keys(tracked)])
  put(untracked)
  return dir
}

async function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'check-deps-'))
  const results = []
  try {
    const db = database(base)
    const all = cases(await closedPort())
    for (const c of all) {
      const dir = fixture(base, c)
      // The local database's directory goes to every case, so the online one cannot fall back to it.
      const { status, lines } = runCheck(dir, { args: c.mode.args, env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db, ...c.mode.env } })
      const said = lines.join(' | ')
      const [want, reason] = c.refuse ? ['fail', c.refuse] : c.skip ? ['skip', c.skip] : ['pass', c.expect]
      let problem = null
      if (status !== want) problem = `${status}, not ${want}: ${said}`
      else if (!lines.some((line) => reason.test(line))) problem = `${status}, but not for that reason: ${said}`
      results.push({ name: c.name, ok: problem === null, detail: problem ?? `${{ pass: 'passes', skip: 'skips', fail: 'fails' }[status]} for that reason` })
      if (c.name.startsWith('control') && problem) {
        console.error(`selftest: the undoctored fixture does not pass, so no case can be trusted: ${problem}`)
        process.exit(1)
      }
    }
    // The gate end to end through its root override, so the exit a hook and CI read is held too. It
    // reads the case with no lockfile, the one a run online settles without asking osv.dev.
    const end = spawnSync(process.execPath, [SELF], {
      env: { ...process.env, DEPS_CHECK_ROOT: join(base, slug(all.find((c) => c.skip).name)) },
      encoding: 'utf8',
    })
    const ok = end.status === 0 && /^deps: skipped, none of the 1 tracked file\(s\)/.test(end.stdout)
    results.push({ name: 'DEPS_CHECK_ROOT points the gate at a copy', ok, detail: ok ? 'exits 0, and says it skipped' : `exited ${end.status}: ${end.stdout}${end.stderr}` })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  console.log(`deps selftest: ${results.length - failed.length}/${results.length} cases hold.`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) await selftest()
else main()

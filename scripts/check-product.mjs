/**
 * Product gate. It runs the checks the product under `src/` names in its own manifests, and refuses
 * a change that breaks one. Each line it prints names one check and one package or project:
 *   1. pnpm: the pnpm on the PATH is the version `src/package.json` names as its `packageManager`.
 *   2. install: `pnpm install --frozen-lockfile --offline` in `src/` passes, so `src/pnpm-lock.yaml`
 *      satisfies every manifest, and `src/node_modules` matches the lockfile.
 *   3. test files: a workspace package that holds a test file (`*.test.*` or `*.spec.*`, outside
 *      `node_modules/`, build output and dot-directories) has a `test` script.
 *   4. typecheck, test and build: each workspace package's script of that name, through
 *      `pnpm --filter <package> run <script>`. A `test` run must also print node:test's `tests <n>`
 *      line with `n` above 0. A package with no such script has no line for that check, so a new
 *      package's scripts join the gate with no edit here.
 *   5. uv test: `uv run --frozen pytest -q` in each directory under `src/` that holds a
 *      `pyproject.toml`, which must exit 0 and report at least one passed test.
 * Every check after the install runs even when an earlier one failed, so one run names every failure.
 *
 * What skips, and what fails. The pnpm checks skip clean when `src/package.json` is absent, and the
 * uv check when no `pyproject.toml` is under `src/`: each is an input the product may not have. Every
 * other absence fails, and names its fix:
 *   - No `src/node_modules`: the gate installs nothing from the network, so `mise run bootstrap`
 *     installs it on a machine, and CI's install step before this gate's step.
 *   - No pnpm or no uv on the PATH: `mise.toml` pins both, and `mise run` installs a missing pin before
 *     any task, so an absent one means the gate ran outside mise.
 *   - No Python that meets a project's `requires-python`: uv downloads a managed CPython when it finds
 *     none, so a Python is missing only when that download fails, and then uv has failed. A tool that
 *     was found and then fails is a failure, never a skip. Skipping instead would let CI, or any
 *     machine without uv or Python, pass a pull request that breaks the Mural tests unseen.
 *
 * THE FAILURE IT EXISTS TO PREVENT. Before this gate, no gate ran the product's own checks:
 * `.github/workflows/verify.yml` and the pre-push jobs ran harness tasks only. So a pull request that
 * broke the server's type check, its tests, the web build or the Mural tests passed every gate. That
 * was found on 2026-11-07, while ss-1ji cleared the dependency gate, whose product checks were run by
 * hand. Were this gate wrong, the same would pass again: a gate that read only an exit code would pass
 * a test script whose glob matches no file, because node:test then exits 0 with `tests 0`; and a gate
 * that skipped on a missing tool would pass every pull request on a runner that lacked it.
 *
 * INVOCATION.
 *
 *   mise run product:check                          the product under src/
 *   mise run product:selftest                       (--selftest) each refusal and skip over fixture workspaces
 *   PRODUCT_CHECK_ROOT=<dir> mise run product:check the same gate over a doctored copy, whose src/ it checks
 *
 * NEEDS pnpm and uv, which `mise.toml` pins and `mise run` puts on the PATH; `src/node_modules`,
 * installed by `mise run bootstrap`; and the network for uv's first sync of each project's environment,
 * and for a Python download when no Python on the machine meets `requires-python`. It writes only what
 * an install and the product's own scripts write, all of it ignored: `src/node_modules` brought up to
 * date from pnpm's store, each package's build output, and each uv project's `.venv/` and pytest's
 * caches. Its selftest needs pnpm and no network: its workspaces have no dependency, and a stub uv
 * stands in for uv and pytest, whose real run is this gate's own over `src/`. 17.9 s wall for the
 * gate over `src/`, its uv environment already synced, and 31.2 s for its 23-case selftest through
 * `mise run` (`/usr/bin/time -p`, one run each) on a macOS laptop with pnpm 11.1.2 and uv 0.13.5,
 * 2026-11-08. The selftest's control case starts pnpm 8 times.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnv } from '../tools/lib/git-env.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.PRODUCT_CHECK_ROOT ? resolve(process.env.PRODUCT_CHECK_ROOT) : REPO_ROOT
// The lines of a failing command's output the gate prints: enough for a compiler's or a runner's last errors.
const TAIL_LINES = 40
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
// Directories a walk for source files skips, beside every dot-directory: installs and build output.
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__'])
const PYTEST_NO_TESTS = 5

const posix = (path) => path.split(sep).join('/')
const tail = (text) => text.trimEnd().split('\n').slice(-TAIL_LINES).map((line) => `      ${line}`).join('\n')

/** Run a command, its output captured; `missing` when it is not on the PATH. */
function exec(command, args, cwd, env) {
  const run = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' })
  const stdout = run.stdout ?? ''
  return { missing: run.error?.code === 'ENOENT', status: run.status ?? run.signal, stdout, out: `${stdout}${run.stderr ?? ''}` }
}

/** The paths, relative to `dir`, of each file under it whose name `match` accepts, outside installs, build output and dot-directories. */
function find(dir, match, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) find(path, match, base, out)
    else if (match(entry.name)) out.push(posix(relative(base, path)))
  }
  return out.sort()
}

/** The last count a line `ℹ tests <n>` (node:test's spec reporter) or `# tests <n>` (its TAP reporter) gives, or null. */
function nodeTestCount(stdout) {
  const match = [...stdout.matchAll(/^(?:ℹ|#) tests (\d+)\s*$/gm)].at(-1)
  return match ? Number(match[1]) : null
}

/** The pnpm workspace's checks, each result passed to `say`. */
function pnpmChecks(root, env, say) {
  const src = join(root, 'src')
  const manifest = join(src, 'package.json')
  if (!existsSync(manifest)) return say('skip', 'pnpm', 'src/', 'no src/package.json, so no pnpm workspace to check')
  let wanted
  try {
    wanted = /^pnpm@(\d+\.\d+\.\d+)$/.exec(JSON.parse(readFileSync(manifest, 'utf8')).packageManager ?? '')?.[1]
  } catch (error) {
    return say('fail', 'pnpm', 'src/package.json', `is not JSON: ${error.message}`)
  }
  if (!wanted) return say('fail', 'pnpm', 'src/package.json', 'names no `pnpm@<version>` as its `packageManager`, so the pnpm to check with is unknown')
  // Asked outside the workspace, because a pnpm run inside it switches itself to the version
  // `packageManager` names, and would then answer that version whatever the PATH holds.
  const version = exec('pnpm', ['--version'], tmpdir(), env)
  if (version.missing) return say('fail', 'pnpm', 'the PATH', 'holds no pnpm; run the gate through `mise run`, which puts the pinned pnpm on the PATH')
  if (version.status !== 0) return say('fail', 'pnpm', 'the PATH', `\`pnpm --version\` exited ${version.status}`, version.out)
  const have = version.stdout.trim().split('\n').at(-1)
  if (have !== wanted) return say('fail', 'pnpm', 'the PATH', `holds pnpm ${have}, and src/package.json's packageManager is pnpm@${wanted}; mise.toml's pin and packageManager move together`)
  say('ok', 'pnpm', 'the PATH', `pnpm ${have}, which src/package.json's packageManager names`)

  if (!existsSync(join(src, 'node_modules'))) return say('fail', 'install', 'src/', 'has no node_modules, and the gate installs nothing from the network; `mise run bootstrap` installs it')
  const install = exec('pnpm', ['install', '--frozen-lockfile', '--offline'], src, env)
  if (install.status !== 0) {
    return say('fail', 'install', 'src/', `\`pnpm install --frozen-lockfile --offline\` exited ${install.status}: src/pnpm-lock.yaml does not satisfy a manifest, or names a package this machine's store lacks, which \`mise run bootstrap\` fetches`, install.out)
  }
  say('ok', 'install', 'src/', 'src/node_modules matches src/pnpm-lock.yaml, which satisfies every manifest')

  const listed = exec('pnpm', ['ls', '-r', '--depth', '-1', '--json'], src, env)
  let projects = null
  try {
    projects = JSON.parse(listed.stdout)
  } catch {}
  if (listed.status !== 0 || !Array.isArray(projects)) return say('fail', 'workspace', 'src/', `\`pnpm ls -r\` exited ${listed.status}, so the workspace's packages are unknown`, listed.out)
  // The workspace's root runs its packages' scripts (`pnpm -r <script>`), so it is a package of its
  // own only in a workspace that holds no other.
  const top = realpathSync(src)
  const packages = (projects.length > 1 ? projects.filter((project) => realpathSync(project.path) !== top) : projects)
    .map((project) => ({ name: project.name, dir: project.path, scripts: JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')).scripts ?? {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const pkg of packages) {
    const tests = find(pkg.dir, (name) => TEST_FILE.test(name))
    if (tests.length > 0 && !pkg.scripts.test) say('fail', 'test files', pkg.name, `${tests.length} test file(s) under ${posix(relative(root, pkg.dir))}, ${tests[0]} among them, and no \`test\` script runs them`)
  }
  for (const script of ['typecheck', 'test', 'build']) {
    for (const pkg of packages.filter((p) => p.scripts[script])) {
      const run = exec('pnpm', ['--filter', pkg.name, 'run', script], src, env)
      if (run.status !== 0) {
        say('fail', script, pkg.name, `\`pnpm --filter ${pkg.name} run ${script}\` exited ${run.status}`, run.out)
        continue
      }
      if (script !== 'test') {
        say('ok', script, pkg.name)
        continue
      }
      const count = nodeTestCount(run.stdout)
      if (count === null) say('fail', 'test', pkg.name, 'its `test` script passed, and printed no node:test `tests <n>` line, so how many tests ran is unknown', run.out)
      else if (count === 0) say('fail', 'test', pkg.name, 'its `test` script ran 0 tests, which passes and checks nothing: a test glob that matches no file does it', run.out)
      else say('ok', 'test', pkg.name, `${count} test(s)`)
    }
  }
}

/** The uv projects' tests, each result passed to `say`. */
function uvChecks(root, env, say) {
  const src = join(root, 'src')
  const projects = existsSync(src) ? find(src, (name) => name === 'pyproject.toml').map((path) => posix(dirname(path))) : []
  if (projects.length === 0) return say('skip', 'uv test', 'src/', 'no pyproject.toml under src/, so no Python project to test')
  for (const project of projects) {
    const subject = project === '.' ? 'src/' : `src/${project}`
    const run = exec('uv', ['run', '--frozen', 'pytest', '-q'], join(src, project), env)
    if (run.missing) {
      say('fail', 'uv test', subject, 'the PATH holds no uv; run the gate through `mise run`, which puts the pinned uv on the PATH')
      continue
    }
    if (run.status !== 0) {
      say('fail', 'uv test', subject, `\`uv run --frozen pytest -q\` exited ${run.status}${run.status === PYTEST_NO_TESTS ? ', which is pytest collecting no test' : ''}`, run.out)
      continue
    }
    const passed = [...run.stdout.matchAll(/\b(\d+) passed\b/g)].at(-1)?.[1]
    if (!passed || Number(passed) === 0) say('fail', 'uv test', subject, 'pytest exited 0 and reported no passed test, so it checked nothing', run.out)
    else say('ok', 'uv test', subject, `${passed} test(s)`)
  }
}

/** Every check over `root`'s `src/`: one `{ status, check, subject, detail, output }` per line. */
export function runCheck(root, { env = gitEnv() } = {}) {
  const results = []
  const say = (status, check, subject, detail = '', output = '') => {
    results.push({ status, check, subject, detail, output })
  }
  pnpmChecks(root, env, say)
  uvChecks(root, env, say)
  return results
}

const line = ({ status, check, subject, detail }) => `${status.padEnd(4)} ${check} ${subject}${detail ? ` -- ${detail}` : ''}`

function main() {
  const results = runCheck(ROOT)
  for (const result of results) {
    console.log(`product: ${line(result)}`)
    if (result.status === 'fail' && result.output.trim()) console.log(tail(result.output))
  }
  const count = (status) => results.filter((result) => result.status === status).length
  if (count('fail') > 0) {
    console.error(`product: refused, ${count('fail')} check(s) failed; each is above, with the end of its output.`)
    process.exit(1)
  }
  if (count('ok') === 0) console.log('product: skipped, src/ holds no pnpm workspace and no Python project.')
  else console.log(`product: passed, ${count('ok')} check(s) ok and ${count('skip')} skipped.`)
}

/* --------------------------------------------------------------------------------- selftest ----- */

const PASSING_TESTS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('adds', () => assert.equal(1 + 1, 2))
test('holds', () => assert.ok(true))
`
const NESTED_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('a test two directories down runs too', () => assert.ok(true))
`
const FAILING_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('fails', () => assert.equal(1, 2))
`
// A stub uv: it refuses any other command, and prints what a passing pytest prints unless the case says otherwise.
const UV_STUB = `#!/bin/sh
[ "$*" = "run --frozen pytest -q" ] || { echo "stub uv: unexpected arguments: $*" >&2; exit 64; }
[ -f pyproject.toml ] || { echo "stub uv: no pyproject.toml in $(pwd)" >&2; exit 65; }
printf '%s\\n' "\${STUB_UV_OUT-...                                                       [100%]
3 passed in 0.01s}"
exit "\${STUB_UV_EXIT:-0}"
`

// A pnpm whose `ls` fails, and which runs the real pnpm, at `pnpm`, for every other command.
const pnpmLsFails = (pnpm) => `#!/bin/sh
[ "$1" = ls ] && { echo "stub pnpm: ls fails" >&2; exit 1; }
exec '${pnpm}' "$@"
`

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/** A workspace every check passes: package a with three tests, package b with none, and a uv project, beside decoys no walk may read. */
function workspace(dir, pnpmVersion) {
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  put('src/package.json', json({ name: 'fixture', private: true, packageManager: `pnpm@${pnpmVersion}`, scripts: { typecheck: 'pnpm -r typecheck' } }))
  put('src/pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
  put('src/packages/a/package.json', json({
    name: '@fixture/a',
    private: true,
    scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node --test "src/**/*.test.mjs"', build: 'node -e "process.exit(0)"' },
  }))
  put('src/packages/a/src/sum.test.mjs', PASSING_TESTS)
  put('src/packages/a/src/deep/nested/more.test.mjs', NESTED_TEST)
  put('src/packages/b/package.json', json({ name: '@fixture/b', private: true, scripts: { typecheck: 'node -e "process.exit(0)"' } }))
  put('src/packages/b/dist/built.test.js', FAILING_TEST)
  put('src/packages/b/.cache/cached.test.js', FAILING_TEST)
  put('src/py/pyproject.toml', '[project]\nname = "fixture"\nversion = "0.1.0"\n')
  put('src/py/uv.lock', 'version = 1\n')
  put('src/py/.venv/lib/pyproject.toml', '[project]\nname = "decoy"\n')
}

const editJson = (path, edit) => writeFileSync(path, json(edit(JSON.parse(readFileSync(path, 'utf8')))))
const editScripts = (dir, pkg, edit) => editJson(join(dir, 'src/packages', pkg, 'package.json'), (m) => ({ ...m, scripts: edit({ ...m.scripts }) }))

/** Each case breaks one thing in a copy of the passing workspace, and names the line its run must print. */
const CASES = [
  {
    name: 'control: every check passes',
    expect: [
      /^ok   pnpm the PATH -- pnpm \S+, which src\/package\.json's packageManager names$/,
      /^ok   install src\/ -- src\/node_modules matches src\/pnpm-lock\.yaml, which satisfies every manifest$/,
      /^ok   typecheck @fixture\/a$/,
      /^ok   typecheck @fixture\/b$/,
      /^ok   test @fixture\/a -- 3 test\(s\)$/,
      /^ok   build @fixture\/a$/,
      /^ok   uv test src\/py -- 3 test\(s\)$/,
    ],
  },
  { name: 'no src/package.json skips the pnpm checks, and says so', edit: (dir) => rmSync(join(dir, 'src/package.json')), find: /^skip pnpm src\/ -- no src\/package\.json, so no pnpm workspace to check$/ },
  { name: 'no pyproject.toml skips the uv check, and says so', edit: (dir) => rmSync(join(dir, 'src/py/pyproject.toml')), find: /^skip uv test src\/ -- no pyproject\.toml under src\/, so no Python project to test$/ },
  {
    name: 'a pnpm other than packageManager names',
    edit: (dir) => editJson(join(dir, 'src/package.json'), (m) => ({ ...m, packageManager: 'pnpm@0.0.1' })),
    find: /^fail pnpm the PATH -- holds pnpm \S+, and src\/package\.json's packageManager is pnpm@0\.0\.1; mise\.toml's pin and packageManager move together$/,
  },
  { name: 'no src/node_modules', edit: (dir) => rmSync(join(dir, 'src/node_modules'), { recursive: true }), find: /^fail install src\/ -- has no node_modules, and the gate installs nothing from the network; `mise run bootstrap` installs it$/ },
  {
    name: 'a manifest the lockfile does not satisfy',
    edit: (dir) => editJson(join(dir, 'src/packages/a/package.json'), (m) => ({ ...m, dependencies: { '@fixture/b': 'workspace:*' } })),
    find: /^fail install src\/ -- `pnpm install --frozen-lockfile --offline` exited 1: src\/pnpm-lock\.yaml does not satisfy a manifest/,
    output: /ERR_PNPM_OUTDATED_LOCKFILE/,
  },
  {
    name: 'a package with test files and no test script',
    edit: (dir) => editScripts(dir, 'a', ({ test, ...rest }) => rest),
    find: /^fail test files @fixture\/a -- 2 test file\(s\) under src\/packages\/a, src\/deep\/nested\/more\.test\.mjs among them, and no `test` script runs them$/,
  },
  { name: 'a failing typecheck', edit: (dir) => editScripts(dir, 'b', (s) => ({ ...s, typecheck: 'node -e "process.exit(2)"' })), find: /^fail typecheck @fixture\/b -- `pnpm --filter @fixture\/b run typecheck` exited 2$/ },
  { name: 'a failing test', edit: (dir) => writeFileSync(join(dir, 'src/packages/a/src/fails.test.mjs'), FAILING_TEST), find: /^fail test @fixture\/a -- `pnpm --filter @fixture\/a run test` exited 1$/, output: /fails/ },
  {
    name: 'a test glob that matches no file',
    edit: (dir) => editScripts(dir, 'a', (s) => ({ ...s, test: 'node --test "nothing/**/*.test.mjs"' })),
    find: /^fail test @fixture\/a -- its `test` script ran 0 tests, which passes and checks nothing/,
  },
  { name: 'a test script that prints no test count', edit: (dir) => editScripts(dir, 'a', (s) => ({ ...s, test: 'node -e "process.exit(0)"' })), find: /^fail test @fixture\/a -- its `test` script passed, and printed no node:test `tests <n>` line/ },
  { name: 'a failing build', edit: (dir) => editScripts(dir, 'a', (s) => ({ ...s, build: 'node -e "process.exit(3)"' })), find: /^fail build @fixture\/a -- `pnpm --filter @fixture\/a run build` exited 3$/ },
  { name: 'failing Python tests', env: { STUB_UV_OUT: 'F..\n1 failed, 2 passed in 0.02s', STUB_UV_EXIT: '1' }, find: /^fail uv test src\/py -- `uv run --frozen pytest -q` exited 1$/, output: /1 failed/ },
  { name: 'pytest collecting no test', env: { STUB_UV_OUT: 'no tests ran in 0.01s', STUB_UV_EXIT: '5' }, find: /^fail uv test src\/py -- `uv run --frozen pytest -q` exited 5, which is pytest collecting no test$/ },
  { name: 'pytest passing with no passed test', env: { STUB_UV_OUT: '' }, find: /^fail uv test src\/py -- pytest exited 0 and reported no passed test, so it checked nothing$/ },
  { name: 'no uv on the PATH fails, and is no skip', path: 'noUv', find: /^fail uv test src\/py -- the PATH holds no uv; run the gate through `mise run`/ },
  { name: 'no pnpm on the PATH fails, and is no skip', path: 'noPnpm', find: /^fail pnpm the PATH -- holds no pnpm; run the gate through `mise run`, which puts the pinned pnpm on the PATH$/ },
  { name: 'a src/package.json that is not JSON', edit: (dir) => writeFileSync(join(dir, 'src/package.json'), '{\n'), find: /^fail pnpm src\/package\.json -- is not JSON: / },
  {
    name: 'a packageManager that names no pnpm version',
    edit: (dir) => editJson(join(dir, 'src/package.json'), ({ packageManager, ...rest }) => rest),
    find: /^fail pnpm src\/package\.json -- names no `pnpm@<version>` as its `packageManager`, so the pnpm to check with is unknown$/,
  },
  { name: 'a pnpm ls that fails', path: 'lsFails', find: /^fail workspace src\/ -- `pnpm ls -r` exited 1, so the workspace's packages are unknown$/, output: /stub pnpm: ls fails/ },
]

const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')

async function selftest() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'check-product-')))
  const results = []
  const record = (name, problem, detail) => results.push({ name, ok: problem === null, detail: problem ?? detail })
  try {
    // The pnpm on this PATH, which `mise run` makes the pinned one, linked into directories of its
    // own, so each case's PATH holds node and the system's tools, and a pnpm and a uv where it says.
    const found = spawnSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).stdout.trim()
    // A mise shim resolves its version from the directory it runs in, and a fixture's directory pins nothing.
    const pnpm = found && realpathSync(found)
    if (!pnpm || /^mise(\.exe)?$/.test(basename(pnpm))) throw new Error(`the PATH's pnpm is ${found ? `a mise shim, ${found}` : 'missing'}; run the selftest through \`mise run\`, which puts the pinned pnpm itself on the PATH`)
    const system = [dirname(process.execPath), '/usr/bin', '/bin']
    /** A PATH whose own directory holds `files`, each written by its function, ahead of `system`. */
    const bin = (name, files) => {
      const dir = join(base, `bin-${name}`)
      mkdirSync(dir)
      for (const [file, write] of Object.entries(files)) write(join(dir, file))
      return [dir, ...system].join(delimiter)
    }
    const linkPnpm = (path) => symlinkSync(pnpm, path)
    const stubUv = (path) => writeFileSync(path, UV_STUB, { mode: 0o755 })
    const PATHS = {
      all: bin('all', { pnpm: linkPnpm, uv: stubUv }),
      noUv: bin('no-uv', { pnpm: linkPnpm }),
      noPnpm: bin('no-pnpm', { uv: stubUv }),
      lsFails: bin('ls-fails', { pnpm: (path) => writeFileSync(path, pnpmLsFails(pnpm), { mode: 0o755 }), uv: stubUv }),
    }
    // The tool a case takes off its PATH, which a copy in a system directory would put back.
    const removes = { noUv: 'uv', noPnpm: 'pnpm' }
    const pnpmVersion = exec('pnpm', ['--version'], base, { ...gitEnv(), PATH: PATHS.noUv }).stdout.trim()

    for (const c of CASES) {
      const dir = join(base, slug(c.name))
      workspace(dir, pnpmVersion)
      const env = { ...gitEnv(), PATH: PATHS[c.path ?? 'all'], ...c.env }
      // The lockfile and node_modules a developer's install leaves, written before the case breaks anything.
      const setup = exec('pnpm', ['install', '--offline', '--no-frozen-lockfile'], join(dir, 'src'), { ...gitEnv(), PATH: PATHS.all })
      if (setup.status !== 0) {
        record(c.name, `the fixture's own install exited ${setup.status}: ${setup.out.trim().split('\n').slice(-3).join(' | ')}`)
        continue
      }
      // A package's install holds test files of its dependencies, which no walk may read.
      mkdirSync(join(dir, 'src/packages/b/node_modules/dependency'), { recursive: true })
      writeFileSync(join(dir, 'src/packages/b/node_modules/dependency/index.test.js'), FAILING_TEST)
      c.edit?.(dir)
      const tool = removes[c.path]
      const stray = tool && system.find((dir) => existsSync(join(dir, tool)))
      if (stray) {
        record(c.name, `a ${tool} in ${stray} is on every case's PATH, so this case cannot take ${tool} away`)
        continue
      }
      const got = runCheck(dir, { env })
      const lines = got.map(line)
      const said = lines.join(' | ')
      let problem = null
      if (c.expect) {
        if (lines.length !== c.expect.length || !c.expect.every((pattern, i) => pattern.test(lines[i]))) problem = `printed ${said}`
      } else {
        const hit = got.find((result) => c.find.test(line(result)))
        if (!hit) problem = `printed no line for that reason: ${said}`
        else if (c.output && !c.output.test(hit.output)) problem = `named the reason, and its output lacks ${c.output}: ${hit.output.trim().split('\n').slice(-3).join(' | ')}`
        else if (c.find.source.startsWith('^fail') !== got.some((result) => result.status === 'fail')) problem = `the run's verdict does not match the line: ${said}`
        // A skip case breaks only the input it skips, so everything else must still pass.
        else if (c.find.source.startsWith('^skip') && got.some((result) => result.status === 'fail')) problem = `skipped, and something else failed: ${said}`
      }
      record(c.name, problem, c.expect ? `${lines.length} line(s), each ok` : 'prints its line for that reason')
      if (c.name.startsWith('control') && problem) {
        console.error(`selftest: the undoctored fixture does not pass, so no case can be trusted: ${problem}`)
        process.exit(1)
      }
    }

    // The gate end to end through its root override, so the exit a hook and CI read is held too.
    const run = (root, env) => spawnSync(process.execPath, [SELF], { env: { ...gitEnv(), PATH: PATHS.all, PRODUCT_CHECK_ROOT: root, ...env }, encoding: 'utf8' })
    const control = run(join(base, slug(CASES[0].name)))
    let ok = control.status === 0 && /^product: passed, 7 check\(s\) ok and 0 skipped\.$/m.test(control.stdout)
    record('PRODUCT_CHECK_ROOT points the gate at a passing copy', ok ? null : `exited ${control.status}: ${control.stdout}${control.stderr}`, 'exits 0, and says it passed')
    const failing = run(join(base, slug('a failing build')))
    ok = failing.status === 1 && /^product: fail build @fixture\/a/m.test(failing.stdout) && /^product: refused, 1 check\(s\) failed/m.test(failing.stderr)
    record('PRODUCT_CHECK_ROOT points the gate at a failing copy', ok ? null : `exited ${failing.status}: ${failing.stdout}${failing.stderr}`, 'exits 1, and names the failing check')
    const empty = join(base, 'empty')
    mkdirSync(empty)
    const skipped = run(empty)
    ok = skipped.status === 0 && /^product: skipped, src\/ holds no pnpm workspace and no Python project\.$/m.test(skipped.stdout)
    record('a root with no src/ skips clean', ok ? null : `exited ${skipped.status}: ${skipped.stdout}${skipped.stderr}`, 'exits 0, and says it skipped')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  console.log(`product selftest: ${results.length - failed.length}/${results.length} cases hold.`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) await selftest()
else main()

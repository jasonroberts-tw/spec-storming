/**
 * The git hook runner. Git's config-based hooks call it, one `hook.asdlc-<event>` entry per event,
 * and it runs that event's jobs from `git-hooks.yml`.
 *
 * WHAT IT DOES. It reads `git-hooks.yml`, which keeps lefthook's schema, and only the part of it this
 * repository used: hook keys `jobs` and `parallel`; job keys `name`, `run`, `glob`, `env` and
 * `group`; group keys `jobs` and `parallel`; and the `run` tokens `{1}`, `{2}`, `{3}` and
 * `{staged_files}`. It refuses any other key or token, an event it does not install, a glob on an
 * event that has no files, and `{staged_files}` outside pre-commit, so a key copied in from
 * another runner's documentation is refused rather than silently ignored. At pre-commit the files
 * are the staged ones; at pre-push they are the pushed ones, from the lines Git writes to its
 * standard input.
 * A job runs when it has no glob, when one of its globs matches one of those files
 * (`path.matchesGlob`, under which `*` stops at `/`), or when the run is forced. It prints one line
 * per job, the jobs it skipped and why, and a total; a failing job also prints the last
 * `gitHooksFailedOutputBytes` (in `policy/tool-settings.json`) of its output and the path of
 * a file holding all of it.
 *
 * THE FAILURE IT EXISTS TO PREVENT. lefthook ran these jobs until this runner replaced it, and
 * this is what that cost:
 *   - its npm postinstall rewrote the hooks every checkout shares from whichever worktree last ran
 *     `npm ci`: on 2026-10-01 all five shims named the binary of one worktree,
 *     `wf_a32cb9f8-89a-2`;
 *   - its install renamed another tool's hook `<hook>.old`, which never runs, and erased a section
 *     appended to its own shim: the tracker's sections the dev container appended on 2025-09-25
 *     survived only as `.backup` copies;
 *   - its bare run skipped every job and exited 0 when the push changed nothing ("36 jobs
 *     skipped, 0.11s, exit 0");
 *   - `npm run gates` printed 34-108 KB. On 2026-10-01 a run with one failing job printed
 *     110,244 bytes, and the agent's harness cut it mid-run;
 *   - its shim ran the lefthook on PATH before the pinned one: a commit on 2026-10-01 ran
 *     Homebrew's 2.1.14, not the pinned 2.1.12;
 *   - a run by hand saw a different environment from a real push, which once let a selftest pass
 *     by hand and damage the repository under a real push (the header of
 *     `scripts/hooks/worktree-hooks.selftest.mjs`).
 * The wrong fix weighed first was lefthook, hardened. If this runner were
 * wrong, a glob it misread would stop a gate on exactly the pushes that change its inputs, and a
 * skip it did not print would read as a pass; `--selftest` holds both.
 * A job gets no `GIT_DIR`. From a linked worktree, `git push` and `mise run gates` hand the hook
 * that worktree's git directory, and `GIT_DIR` outranks a git command's directory. On 2026-10-14
 * and 2026-10-15, `integrations:selftest` ran `git init <scratch dir>` under it, which
 * re-initialised this repository and set `core.bare = true` in the config every checkout shares.
 * Before then each selftest dropped `GIT_*` itself, with `tools/lib/git-env.ts` or a copy of it,
 * and that one call did not. A job runs at the checkout's top, so git still finds the repository.
 * `GIT_INDEX_FILE` stays, because pre-commit needs the index that `git commit -a` names.
 *
 * WHAT IT NEVER BLOCKS. `git worktree add` runs post-checkout in the new worktree and fails when it
 * fails, and a new worktree has no `node_modules` until `npm ci`. So at prepare-commit-msg,
 * post-checkout and post-merge, which gate nothing, a runner that cannot start (no `js-yaml`, a job
 * file it refuses, an older Git) prints why and exits 0; a job that runs and fails still fails the
 * event. At pre-commit and pre-push the same refusal fails the commit or the push.
 *
 * INVOCATION.
 *   node scripts/git-hooks.mjs <event> [git's arguments]   what each `hook.asdlc-<event>.command` runs
 *   mise run gates           (--gates) the pre-push suite through `git hook run --to-stdin`, forced, with
 *                           the branch's push line, so it sees a real push's environment and input
 *   mise run hooks:install   (--install) writes the five `hook.asdlc-*` entries into the repository's
 *                           own config and removes lefthook's shims from the hooks directory
 *   npm's `prepare`         (--prepare) the install, skipped when `CI` is set; `npm ci` runs it
 *   mise run hooks:selftest  (--selftest) every refusal and every path above, in scratch repositories
 *   GIT_HOOKS_FORCE=1       runs every job, whatever its glob
 *   GIT_HOOKS_SKIP=1        runs none, and says so
 *   GIT_HOOKS_ROOT=<dir>    reads `git-hooks.yml` and `policy/` from a doctored copy, and
 *                           runs its jobs and git there
 *
 * NEEDS. Git 2.54.0 or later, the first that reads `hook.*` (the install and the gates refuse an
 * older one); Node 22.20.0 or later for `path.matchesGlob`, inside the `engines` floor; `js-yaml`
 * from `node_modules`; the policy's loader, `tools/lib/policy.ts`, beside it. No network. The
 * selftest needs `sh` for the cases that fake an old Git or send a signal, and skips them, saying
 * so, on Windows.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { POLICY_DIR, copyPolicy, editPolicy, readPolicy } from '../tools/lib/policy.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.GIT_HOOKS_ROOT ? resolve(process.env.GIT_HOOKS_ROOT) : REPO_ROOT

const JOB_FILE = 'git-hooks.yml'
/** The policy's loader, which the selftest's scratch repositories copy beside this file. */
const LOADER = 'tools/lib/policy.ts'
/** The record that holds the cap, named in a refusal. */
const CAP_RECORD = 'policy/tool-settings.json'
const CAP_KEY = 'gitHooksFailedOutputBytes'
/** The events this runner installs, in the order Git meets them in a commit and a push. */
const EVENTS = ['pre-commit', 'prepare-commit-msg', 'post-checkout', 'post-merge', 'pre-push']
/** The events that gate nothing: a runner that cannot start there says why and exits 0. */
const NON_GATING = new Set(['prepare-commit-msg', 'post-checkout', 'post-merge'])
/** The events that have files for a glob to match. */
const FILE_EVENTS = new Set(['pre-commit', 'pre-push'])
const HOOK_KEYS = ['jobs', 'parallel']
const JOB_KEYS = ['name', 'run', 'glob', 'env', 'group']
const GROUP_KEYS = ['jobs', 'parallel']
const TOKENS = ['1', '2', '3', 'staged_files']
const MIN_GIT = [2, 54, 0]
const HOOK_PREFIX = 'asdlc-'
const ZERO_SHA = /^0+$/
/** The text lefthook's generated shim carries, and the marker of the tracker's appended section. */
const LEFTHOOK_SHIM = 'call_lefthook'
const BEADS_SECTION = 'BEGIN BEADS INTEGRATION'

const commandFor = (event) => `node scripts/git-hooks.mjs ${event}`

/** A refusal: a reason the runner prints, never a stack. */
class Refusal extends Error {}

/* ------------------------------------------------------------------------------- reading ----- */

/**
 * The job file at `root`, read and held to the subset the header names. Returns, per event, its
 * `parallel` and its entries in order, each a job or a group of jobs.
 */
async function readJobs(root) {
  const path = join(root, JOB_FILE)
  if (!existsSync(path)) throw new Refusal(`${JOB_FILE} is missing at ${path}`)
  let load
  try {
    ;({ load } = await import('js-yaml'))
  } catch {
    throw new Refusal(`js-yaml cannot be loaded from ${root}: there is no node_modules here; run npm ci`)
  }
  let doc
  try {
    doc = load(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Refusal(`${JOB_FILE} does not parse as YAML: ${error.message.split('\n')[0]}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Refusal(`${JOB_FILE} is not a map of events`)
  }
  const hooks = {}
  for (const [event, spec] of Object.entries(doc)) {
    if (!EVENTS.includes(event)) {
      throw new Refusal(
        `${JOB_FILE}: \`${event}\` is not an event this runner installs (${EVENTS.join(', ')})`,
      )
    }
    const where = event
    keysWithin(spec, HOOK_KEYS, where)
    const parallel = booleanAt(spec.parallel, `${where}.parallel`)
    const entries = jobsAt(spec.jobs, `${where}.jobs`).map((job, index) =>
      readEntry(event, job, `${where}.jobs[${index}]`),
    )
    const names = entries.flatMap((entry) =>
      entry.group ? entry.group.jobs.map((job) => `${entry.name}/${job.name}`) : [entry.name],
    )
    const repeated = names.find((name, index) => names.indexOf(name) !== index)
    if (repeated) throw new Refusal(`${JOB_FILE}: \`${event}\` names the job \`${repeated}\` twice`)
    hooks[event] = { parallel, entries }
  }
  return hooks
}

function keysWithin(value, allowed, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Refusal(`${JOB_FILE}: \`${where}\` is not a map`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Refusal(
        `${JOB_FILE}: \`${where}\` has the key \`${key}\`, which this runner does not read` +
          ` (it reads ${allowed.join(', ')}); a key it ignored would change nothing and say nothing`,
      )
    }
  }
}

function booleanAt(value, where) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Refusal(`${JOB_FILE}: \`${where}\` is not true or false`)
  return value
}

function jobsAt(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Refusal(`${JOB_FILE}: \`${where}\` is not a list of jobs`)
  }
  return value
}

function readEntry(event, job, where) {
  const named = typeof job?.name === 'string' && job.name !== ''
  keysWithin(job, JOB_KEYS, named ? `${event}/${job.name}` : where)
  if (!named) throw new Refusal(`${JOB_FILE}: \`${where}\` has no name`)
  const label = `${event}/${job.name}`
  if ((job.run === undefined) === (job.group === undefined)) {
    throw new Refusal(`${JOB_FILE}: \`${label}\` must have exactly one of \`run\` and \`group\``)
  }
  if (job.group !== undefined) {
    if (job.glob !== undefined || job.env !== undefined) {
      throw new Refusal(
        `${JOB_FILE}: the group \`${label}\` carries a glob or an env; its jobs carry their own`,
      )
    }
    keysWithin(job.group, GROUP_KEYS, `${label}.group`)
    return {
      name: job.name,
      group: {
        parallel: booleanAt(job.group.parallel, `${label}.group.parallel`),
        jobs: jobsAt(job.group.jobs, `${label}.group.jobs`).map((inner, index) => {
          const read = readEntry(event, inner, `${label}.group.jobs[${index}]`)
          if (read.group) throw new Refusal(`${JOB_FILE}: \`${label}\` holds a group inside a group`)
          return read
        }),
      },
    }
  }
  if (typeof job.run !== 'string' || job.run.trim() === '') {
    throw new Refusal(`${JOB_FILE}: \`${label}\` has an empty \`run\``)
  }
  for (const [, token] of job.run.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!TOKENS.includes(token)) {
      throw new Refusal(
        `${JOB_FILE}: \`${label}\` uses \`{${token}}\`, which this runner does not expand` +
          ` (it expands ${TOKENS.map((t) => `{${t}}`).join(', ')})`,
      )
    }
    if (token === 'staged_files' && event !== 'pre-commit') {
      throw new Refusal(`${JOB_FILE}: \`${label}\` uses \`{staged_files}\`, which only pre-commit has`)
    }
  }
  let globs = null
  if (job.glob !== undefined) {
    if (!FILE_EVENTS.has(event)) {
      throw new Refusal(
        `${JOB_FILE}: \`${label}\` has a glob, but ${event} has no files for it to match`,
      )
    }
    globs = typeof job.glob === 'string' ? [job.glob] : job.glob
    if (!Array.isArray(globs) || globs.length === 0 || globs.some((g) => typeof g !== 'string' || g === '')) {
      throw new Refusal(`${JOB_FILE}: \`${label}\` has a glob that is not a string or a list of them`)
    }
  }
  let env = {}
  if (job.env !== undefined) {
    keysWithin(job.env, Object.keys(job.env), `${label}.env`)
    for (const [key, value] of Object.entries(job.env)) {
      if (typeof value !== 'string') {
        throw new Refusal(`${JOB_FILE}: \`${label}.env.${key}\` is not a string; quote it`)
      }
    }
    env = job.env
  }
  return { name: job.name, run: job.run, globs, env }
}

/** The cap on a failing job's printed output, from the policy at `root`. */
function readCap(root) {
  let policy
  try {
    policy = readPolicy(root)
  } catch (error) {
    throw new Refusal(`${POLICY_DIR}/ cannot be read at ${join(root, POLICY_DIR)}: ${error.message}`)
  }
  const cap = policy[CAP_KEY]
  if (!Number.isInteger(cap) || cap <= 0 || typeof policy[`${CAP_KEY}Means`] !== 'string') {
    throw new Refusal(
      `${CAP_RECORD} has no whole-number \`${CAP_KEY}\` with a \`${CAP_KEY}Means\` beside it,` +
        ' so a failing job has no cap on what it prints',
    )
  }
  return cap
}

/* ---------------------------------------------------------------------------------- git ----- */

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
}

function gitLines(args, options) {
  const result = git(args, options)
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : null
}

/** Git's version, refused below `MIN_GIT`. */
function requireGit() {
  const result = git(['--version'])
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? '')
  if (result.status !== 0 || !found) throw new Refusal('git --version did not answer, so Git cannot be checked')
  const version = found.slice(1, 4).map(Number)
  const floor = MIN_GIT.join('.')
  for (let i = 0; i < 3; i++) {
    if (version[i] > MIN_GIT[i]) return
    if (version[i] < MIN_GIT[i]) {
      throw new Refusal(
        `Git ${version.join('.')} is older than ${floor}, the first that runs config-based hooks:` +
          ` under it no hook here runs, and nothing says so. Install Git ${floor} or later.`,
      )
    }
  }
}

/** Where the classic hooks live, honouring `core.hooksPath`. */
function hooksDir() {
  const result = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])
  return result.status === 0 ? result.stdout.trim() : null
}

/** Warnings about the classic hook Git runs after this one for `event`. */
function classicWarnings(event) {
  const dir = hooksDir()
  if (!dir) return []
  const path = join(dir, event)
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const warnings = []
  if (text.includes(LEFTHOOK_SHIM)) {
    warnings.push(
      `warning: ${path} is a lefthook shim, and Git runs it after this runner;` +
        ' `mise run hooks:install` removes it',
    )
  }
  if (text.includes(BEADS_SECTION)) {
    warnings.push(
      `warning: ${path} carries the tracker's own hook, so bd runs a second time after its job in` +
        ` ${JOB_FILE}; remove that section`,
    )
  }
  return warnings
}

/* --------------------------------------------------------------------------- the files ----- */

/** The staged files at pre-commit, under the index Git hands the hook. */
function stagedFiles() {
  const files = gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  if (files === null) throw new Refusal('git diff --cached failed, so the staged files are unknown')
  return files
}

/**
 * The pushed files at pre-push, one push line at a time, each with a line saying which range it
 * took. Null files means a line named no ref, so nothing was pushed.
 */
function pushedFiles(input) {
  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return { files: null, notes: ['standard input named no ref: nothing was pushed'] }
  const files = new Set()
  const notes = []
  const short = (sha) => sha.slice(0, 7)
  const tracked = (sha) => gitLines(['ls-tree', '-r', '--name-only', '-z', sha]) ?? gitLines(['ls-files', '-z']) ?? []
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/)
    if (!remoteSha) {
      notes.push(`a push line this runner cannot read ("${line}"): every tracked file`)
      for (const file of gitLines(['ls-files', '-z']) ?? []) files.add(file)
      continue
    }
    if (ZERO_SHA.test(localSha)) {
      notes.push(`${remoteRef}: deleted, so no files`)
      continue
    }
    let range = null
    let note
    if (ZERO_SHA.test(remoteSha)) {
      const base = git(['merge-base', 'origin/main', localSha])
      if (base.status === 0) {
        range = [base.stdout.trim(), localSha]
        note = `${remoteRef}: a new branch, so the files since its merge base with origin/main (${short(range[0])})`
      } else {
        note = `${remoteRef}: a new branch with no merge base with origin/main, so every tracked file`
      }
    } else if (git(['cat-file', '-e', `${remoteSha}^{commit}`]).status === 0) {
      range = [remoteSha, localSha]
      note = `${remoteRef}: ${short(remoteSha)}..${short(localSha)}`
    } else {
      note = `${remoteRef}: the remote's ${short(remoteSha)} is not in this repository, so every tracked file`
    }
    const found = range
      ? gitLines(['diff', '--name-only', '--no-renames', '-z', range[0], range[1]])
      : tracked(localSha)
    if (found === null) {
      notes.push(`${remoteRef}: git diff failed, so every tracked file`)
      for (const file of tracked(localSha)) files.add(file)
      continue
    }
    for (const file of found) files.add(file)
    notes.push(`${note}, ${found.length} file(s)`)
  }
  return { files: [...files], notes }
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  try {
    for await (const chunk of process.stdin) chunks.push(chunk)
  } catch {
    return ''
  }
  return Buffer.concat(chunks).toString('utf8')
}

/* ---------------------------------------------------------------------------- the jobs ----- */

const quote =
  process.platform === 'win32'
    ? (value) => `"${value.replace(/"/g, '""')}"`
    : (value) => `'${value.replace(/'/g, `'\\''`)}'`

/** A job's command line with its tokens expanded. */
function expand(run, args, matched) {
  return run.replace(/\{([A-Za-z0-9_]+)\}/g, (_, token) => {
    if (token === 'staged_files') return matched.map(quote).join(' ')
    const value = args[Number(token) - 1]
    return value === undefined ? '' : quote(value)
  })
}

/**
 * Lanes: each a list of jobs run one after another. A parallel hook gives each entry its own lane,
 * and a sequential group keeps its jobs in one; a sequential hook is one lane.
 */
function lanes(hook) {
  const flat = (entry) =>
    entry.group ? entry.group.jobs.map((job) => ({ ...job, name: `${entry.name}/${job.name}` })) : [entry]
  if (!hook.parallel) return [hook.entries.flatMap(flat)]
  return hook.entries.flatMap((entry) =>
    entry.group && entry.group.parallel ? flat(entry).map((job) => [job]) : [flat(entry)],
  )
}

const running = new Set()

function runJob(job, command) {
  return new Promise((done) => {
    const started = performance.now()
    const chunks = []
    const { GIT_DIR: _, ...inherited } = process.env
    const child = spawn(command, {
      cwd: ROOT,
      env: { ...inherited, ...job.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    running.add(child)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    const finish = (code, signal, error) => {
      running.delete(child)
      if (error) chunks.push(Buffer.from(`${error.message}\n`))
      done({
        name: job.name,
        code: code ?? (signal ? `signal ${signal}` : 1),
        ok: code === 0 && !error,
        seconds: (performance.now() - started) / 1000,
        output: Buffer.concat(chunks),
      })
    }
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** Kill every job's process group, so no child outlives the runner. */
function killAll(signal) {
  for (const child of running) {
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killAll(signal)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

/** Run one event's jobs over `files`, printing as each finishes. Returns the exit status. */
async function runEvent(event, hook, { args, files, force, cap, out }) {
  const started = performance.now()
  const all = lanes(hook)
  const width = Math.max(...all.flat().map((job) => job.name.length))
  const skipped = []
  let passed = 0
  let failed = 0
  let logDir = null
  const report = (result) => {
    const seconds = `${result.seconds.toFixed(2)} s`
    if (result.ok) {
      passed++
      out(`  ok    ${result.name.padEnd(width)}  ${seconds}`)
      return
    }
    failed++
    logDir ??= mkdtempSync(join(tmpdir(), 'git-hooks-'))
    const log = join(logDir, `${result.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`)
    writeFileSync(log, result.output)
    const size = result.output.length
    const shown = size > cap ? result.output.subarray(size - cap) : result.output
    out(`  FAIL  ${result.name.padEnd(width)}  ${seconds}, exit ${result.code}`)
    out(
      size > cap
        ? `        the last ${cap} of its ${size} bytes; all of them are in ${log}`
        : `        its ${size} bytes, also in ${log}`,
    )
    out(shown.toString('utf8').replace(/\s+$/, ''))
    out(`  ----  end of ${result.name}`)
  }
  const wants = (job) => {
    if (force || job.globs === null || !FILE_EVENTS.has(event)) return { run: true, matched: files ?? [] }
    const matched = (files ?? []).filter((file) => job.globs.some((glob) => matchesGlob(file, glob)))
    return { run: matched.length > 0, matched }
  }
  const runLane = async (lane) => {
    for (const job of lane) {
      const { run, matched } = wants(job)
      if (!run) {
        skipped.push(job.name)
        continue
      }
      report(await runJob(job, expand(job.run, args, matched)))
    }
  }
  const queue = [...all]
  const workers = Array.from({ length: Math.min(availableParallelism(), queue.length) }, async () => {
    while (queue.length > 0) await runLane(queue.shift())
  })
  await Promise.all(workers)
  if (skipped.length > 0) {
    const order = all.flat().map((job) => job.name)
    skipped.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const why = event === 'pre-commit' ? 'the commit stages none of their files' : 'the push changed none of their files'
    out(`  ${skipped.length} job(s) skipped: ${why} (${skipped.join(', ')})`)
  }
  const total = passed + failed + skipped.length
  const seconds = ((performance.now() - started) / 1000).toFixed(2)
  out(
    `git-hooks ${event}: ${total} job(s), ${passed} passed, ${failed} failed, ${skipped.length}` +
      ` skipped, ${seconds} s${failed > 0 ? ': the run fails' : ''}`,
  )
  return failed > 0 ? 1 : 0
}

/* --------------------------------------------------------------------------- the modes ----- */

async function hookMain(event, args) {
  const out = (line) => process.stdout.write(`${line}\n`)
  if (process.env.GIT_HOOKS_SKIP === '1') {
    out(`git-hooks ${event}: GIT_HOOKS_SKIP=1, so no job ran`)
    return 0
  }
  let hook
  let cap
  try {
    requireGit()
    const hooks = await readJobs(ROOT)
    hook = hooks[event]
    if (!hook) throw new Refusal(`${JOB_FILE} has no \`${event}\` block, and Git ran its hook`)
    cap = readCap(ROOT)
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    if (NON_GATING.has(event)) {
      out(`git-hooks ${event}: ${error.message}; its jobs did not run`)
      return 0
    }
    out(`git-hooks ${event}: refused. ${error.message}`)
    return 1
  }
  for (const warning of classicWarnings(event)) out(`git-hooks ${event}: ${warning}`)
  const force = process.env.GIT_HOOKS_FORCE === '1'
  if (force) out(`git-hooks ${event}: GIT_HOOKS_FORCE=1, so every job runs, whatever its glob`)
  let files = null
  try {
    if (event === 'pre-commit') files = stagedFiles()
    if (event === 'pre-push') {
      const pushed = pushedFiles(await readStdin())
      for (const note of pushed.notes) out(`git-hooks pre-push: ${note}`)
      files = pushed.files ?? []
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    out(`git-hooks ${event}: refused. ${error.message}`)
    return 1
  }
  return runEvent(event, hook, { args, files, force, cap, out })
}

/** Write the five `hook.asdlc-*` entries, and remove lefthook's shims. */
function install({ prepare }) {
  const label = prepare ? 'git-hooks --prepare' : 'git-hooks --install'
  if (prepare && process.env.CI) {
    console.log(`${label}: CI is set, so no hook is installed`)
    return 0
  }
  // No Git at all is an absent input, so `npm ci` still installs; an older Git is a refusal.
  if (git(['--version']).error) {
    console.log(`${label}: no Git on PATH, so no hook is installed`)
    return 0
  }
  try {
    requireGit()
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    console.error(`${label}: refused, and nothing was written. ${error.message}`)
    return 1
  }
  if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') {
    console.log(`${label}: ${ROOT} is not a Git checkout, so no hook is installed`)
    return 0
  }
  const set = (key, value) => {
    const current = gitLines(['config', '--local', '-z', '--get-all', key])
    if (current && current.length === 1 && current[0] === value) return `unchanged ${key}`
    const result = git(['config', 'set', '--local', '--all', key, value])
    if (result.status !== 0) throw new Error(`git config set ${key} failed: ${result.stderr}`)
    return `wrote     ${key} = ${value}`
  }
  for (const event of EVENTS) {
    console.log(`${label}: ${set(`hook.${HOOK_PREFIX}${event}.command`, commandFor(event))}`)
    console.log(`${label}: ${set(`hook.${HOOK_PREFIX}${event}.event`, event)}`)
  }
  const dir = hooksDir()
  for (const name of dir && existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (name.endsWith('.sample')) continue
    const path = join(dir, name)
    if (!statSync(path).isFile()) continue
    const text = readFileSync(path, 'utf8')
    if (/\.(old|backup)$/.test(name)) {
      console.log(`${label}: left      ${path}: a copy Git never runs; delete it by hand once read`)
    } else if (text.includes(LEFTHOOK_SHIM)) {
      rmSync(path)
      const bd = text.includes(BEADS_SECTION) ? ', with the tracker\'s section appended, which its job in git-hooks.yml replaces' : ''
      console.log(`${label}: removed   ${path}: a lefthook shim${bd}`)
    } else if (text.includes(BEADS_SECTION)) {
      console.log(
        `${label}: left      ${path}: the tracker's own hook. Git runs it after this runner, so bd` +
          ` runs twice for ${name}; remove its section`,
      )
    }
  }
  const checksum = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/lefthook.checksum']).stdout?.trim()
  if (checksum && existsSync(checksum)) {
    rmSync(checksum)
    console.log(`${label}: removed   ${checksum}`)
  }
  return 0
}

/** `mise run gates`: the pre-push hook through Git, forced, with the branch's push line. */
function gates() {
  try {
    requireGit()
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    console.error(`gates: refused. ${error.message}`)
    return 1
  }
  const installed = gitLines(['config', '-z', '--get-all', `hook.${HOOK_PREFIX}pre-push.command`])
  if (!installed || !installed.includes(commandFor('pre-push'))) {
    console.error(
      `gates: refused. This checkout's Git config has no \`hook.${HOOK_PREFIX}pre-push.command\`` +
        ` = \`${commandFor('pre-push')}\`, so no push here runs a gate. Run \`mise run hooks:install\`.`,
    )
    return 1
  }
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD']).stdout?.trim()
  const localRef = branch ? `refs/heads/${branch}` : 'HEAD'
  let remote = 'origin'
  let remoteRef = localRef
  let remoteSha = '0'.repeat(head.length)
  if (branch) {
    const configured = git(['config', '--get', `branch.${branch}.remote`]).stdout?.trim()
    if (configured) remote = configured
    const upstream = git(['rev-parse', '--verify', '-q', '@{upstream}'])
    const merged = git(['config', '--get', `branch.${branch}.merge`]).stdout?.trim()
    if (upstream.status === 0 && merged) {
      remoteSha = upstream.stdout.trim()
      remoteRef = merged
    }
  }
  const url = git(['remote', 'get-url', remote]).stdout?.trim() || remote
  const dir = mkdtempSync(join(tmpdir(), 'git-hooks-gates-'))
  const stdin = join(dir, 'pre-push.stdin')
  writeFileSync(stdin, `${localRef} ${head} ${remoteRef} ${remoteSha}\n`)
  const result = spawnSync('git', ['hook', 'run', `--to-stdin=${stdin}`, 'pre-push', '--', remote, url], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GIT_HOOKS_FORCE: '1' },
  })
  rmSync(dir, { recursive: true, force: true })
  return result.status ?? 1
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === '--selftest') return selftest()
  if (mode === '--install') return install({ prepare: false })
  if (mode === '--prepare') return install({ prepare: true })
  if (mode === '--gates') return gates()
  if (EVENTS.includes(mode)) return hookMain(mode, rest)
  console.error(
    `usage: node scripts/git-hooks.mjs <${EVENTS.join('|')}> [git's arguments]` +
      ' | --install | --prepare | --gates | --selftest',
  )
  return 2
}

/* ---------------------------------------------------------------------------- selftest ----- */

/**
 * Whether `pid` names a process that has not exited. A zombie has exited and waits on a parent to reap
 * it, and `process.kill(pid, 0)` still finds it; where PID 1 reaps no orphan, as in the dev container,
 * a job the runner killed stays one, so on Linux its state in `/proc` decides. A `/proc` it cannot
 * read leaves the signal's answer, so a job that runs on is never read as gone.
 */
function pidRuns(pid) {
  const signalled = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!signalled()) return false
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat[stat.lastIndexOf(')') + 2] !== 'Z'
  } catch {
    return signalled()
  }
}

/**
 * Every refusal over a doctored copy of the job file or the policy, asserting its reason, beside an
 * undoctored control over the real `git-hooks.yml`; then every path through real Git in scratch
 * repositories with a bare remote, each with a copy of this file, a fixture job file and
 * `node_modules` linked in, beside a control commit and push that must pass. Git runs there with no
 * `GIT_*` variable of this process, `GIT_HOOKS_*` included, and no global or system config, so a run
 * inside a real push neither reads nor writes this repository.
 */
async function selftest() {
  const { gitEnv } = await import('../tools/lib/git-env.ts')
  const base = mkdtempSync(join(tmpdir(), 'git-hooks-selftest-'))
  const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok, detail })
  try {
    await readingCases(base, record)
    await gitCases(base, env, record)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  const failed = results.filter((result) => !result.ok)
  console.log(`hooks selftest: ${results.length - failed.length}/${results.length} cases hold`)
  return failed.length === 0 ? 0 : 1
}

/** Refusals of the reader and the cap, each over a doctored copy, beside the real file. */
async function readingCases(base, record) {
  const real = readFileSync(join(REPO_ROOT, JOB_FILE), 'utf8')
  const cases = [
    { name: 'control: the real git-hooks.yml and policy are read', doctor: (t) => t, expect: 'pass' },
    {
      name: 'a job key this runner does not read is refused',
      doctor: (t) => t.replace('    - name: beads\n      env:', '    - name: beads\n      skip: true\n      env:'),
      expect: /`pre-push\/beads` has the key `skip`, which this runner does not read/,
    },
    {
      name: 'an event this runner does not install is refused',
      doctor: (t) => `${t}\ncommit-msg:\n  jobs:\n    - name: x\n      run: echo x\n`,
      expect: /`commit-msg` is not an event this runner installs/,
    },
    {
      name: 'a hook key this runner does not read is refused',
      doctor: (t) => t.replace('pre-push:\n', 'pre-push:\n  piped: true\n'),
      expect: /`pre-push` has the key `piped`, which this runner does not read/,
    },
    {
      name: 'an env value that is not a string is refused',
      doctor: (t) => t.replace("NO_COLOR: '1'", 'NO_COLOR: 1'),
      expect: /`pre-push\/beads\.env\.NO_COLOR` is not a string/,
    },
    {
      name: 'a policy without the cap is refused',
      doctor: (t) => t,
      policy: (p) => {
        delete p[CAP_KEY]
      },
      expect: /has no whole-number `gitHooksFailedOutputBytes`/,
    },
    {
      name: 'a missing job file is refused',
      doctor: (t) => t,
      removeJobs: true,
      expect: /git-hooks\.yml is missing at/,
    },
    {
      name: 'a job file that does not parse is refused',
      doctor: (t) => `${t}  - [unclosed\n`,
      expect: /git-hooks\.yml does not parse as YAML/,
    },
    {
      name: 'a job file that is not a map of events is refused',
      doctor: () => '- pre-commit\n- pre-push\n',
      expect: /git-hooks\.yml is not a map of events/,
    },
    {
      name: 'a parallel that is not true or false is refused',
      doctor: (t) => t.replace('  parallel: true\n', "  parallel: 'yes'\n"),
      expect: /`pre-push\.parallel` is not true or false/,
    },
    {
      name: 'an event with an empty list of jobs is refused',
      doctor: () => 'pre-commit:\n  jobs: []\n',
      expect: /`pre-commit\.jobs` is not a list of jobs/,
    },
    {
      name: 'a job name used twice in one event is refused',
      doctor: (t) => `${t}    - name: citations\n      run: mise run citations:check\n`,
      expect: /`pre-push` names the job `citations` twice/,
    },
    {
      name: 'a job with no name is refused',
      doctor: (t) => `${t}    - run: echo nameless\n`,
      expect: /`pre-push\.jobs\[\d+\]` has no name/,
    },
    {
      name: 'a group inside a group is refused',
      doctor: (t) => `${t}    - name: outer\n      group:\n        jobs:\n          - name: inner\n            group:\n              jobs:\n                - name: deepest\n                  run: echo deepest\n`,
      expect: /`pre-push\/outer` holds a group inside a group/,
    },
    {
      name: 'a policy that cannot be read is refused',
      doctor: (t) => t,
      removePolicy: true,
      expect: /policy\/ cannot be read at .*no policy record/,
    },
  ]
  for (const [index, { name, doctor, policy, removeJobs, removePolicy, expect }] of cases.entries()) {
    const dir = join(base, `reading-${index}`)
    mkdirSync(dir, { recursive: true })
    const doctored = doctor(real)
    if (expect !== 'pass' && !policy && !removeJobs && !removePolicy && doctored === real) {
      record(name, false, 'the doctoring changed nothing, so the fixture is broken')
      continue
    }
    if (!removeJobs) writeFileSync(join(dir, JOB_FILE), doctored)
    if (!removePolicy) copyPolicy(REPO_ROOT, dir)
    if (policy) editPolicy(dir, policy)
    let message = null
    try {
      await readJobs(dir)
      readCap(dir)
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      message = error.message
    }
    if (expect === 'pass') record(name, message === null, message === null ? 'passes' : `refused: ${message}`)
    else if (message === null) record(name, false, 'PASSED, but should have been refused')
    else record(name, expect.test(message), expect.test(message) ? 'refused for that reason' : `refused, but not for that reason: ${message}`)
  }
}

/** The fixture job file every scratch repository starts from. */
const FIXTURE_JOBS = `pre-commit:
  parallel: false
  jobs:
    - name: md-only
      glob: '**/*.md'
      run: node record.mjs md-only {staged_files}
    - name: txt-only
      glob: '*.txt'
      run: node record.mjs txt-only {staged_files}
prepare-commit-msg:
  jobs:
    - name: args
      run: node record.mjs prepare-commit-msg {1} {2} {3}
post-checkout:
  jobs:
    - name: args
      run: node record.mjs post-checkout {1} {2} {3}
post-merge:
  jobs:
    - name: args
      run: node record.mjs post-merge {1}
pre-push:
  parallel: true
  jobs:
    - name: always
      env:
        FIXTURE_MARK: 'set'
      run: node record.mjs always {1} {2}
    - name: docs
      glob:
        - 'docs/**'
      run: node record.mjs docs
    - name: code
      glob: 'src/**'
      run: node record.mjs code
`

/** A job command that records its name, its arguments and its environment, and may fail or talk. */
const RECORD = `import { appendFileSync, writeFileSync } from 'node:fs'
const [name, ...rest] = process.argv.slice(2)
let exit = 0
let print = 0
let sleep = 0
const args = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--exit') exit = Number(rest[++i])
  else if (rest[i] === '--print') print = Number(rest[++i])
  else if (rest[i] === '--sleep') sleep = Number(rest[++i])
  else args.push(rest[i])
}
appendFileSync('ran.log', JSON.stringify({ name, args, force: process.env.GIT_HOOKS_FORCE ?? null, mark: process.env.FIXTURE_MARK ?? null, gitDir: process.env.GIT_DIR ?? null, index: process.env.GIT_INDEX_FILE ?? null }) + '\\n')
if (print) process.stdout.write('BEGIN\\n' + 'x'.repeat(print) + '\\nEND\\n')
if (sleep) {
  writeFileSync(name + '.pid', String(process.pid))
  setTimeout(() => process.exit(exit), sleep)
} else process.exit(exit)
`

/** Every path through real Git, each in a scratch repository of its own. */
async function gitCases(base, env, record) {
  let counter = 0
  const g = (cwd, args, extra = {}) =>
    spawnSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
  const ok = (cwd, args, extra) => {
    const result = g(cwd, args, extra)
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
    return result.stdout
  }
  const node = (cwd, args, extra = {}) =>
    spawnSync(process.execPath, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
  const linkModules = (dir) =>
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const ran = (dir) =>
    existsSync(join(dir, 'ran.log'))
      ? readFileSync(join(dir, 'ran.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  const clear = (dir) => rmSync(join(dir, 'ran.log'), { force: true })
  const both = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`
  /** A scratch repository with the runner, the fixture, a pushed main and the hooks installed. */
  const scratch = (jobs = FIXTURE_JOBS, { modules = true, installHooks = true } = {}) => {
    const dir = join(base, `git-${counter++}`)
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'tools', 'lib'), { recursive: true })
    ok(dir, ['init', '-q', '--bare', '-b', 'main', 'remote.git'])
    ok(repo, ['init', '-q', '-b', 'main'])
    ok(repo, ['config', 'user.email', 'selftest@example.invalid'])
    ok(repo, ['config', 'user.name', 'selftest'])
    copyFileSync(SELF, join(repo, 'scripts', 'git-hooks.mjs'))
    copyFileSync(join(REPO_ROOT, LOADER), join(repo, LOADER))
    copyPolicy(REPO_ROOT, repo)
    writeFileSync(join(repo, JOB_FILE), jobs)
    writeFileSync(join(repo, 'record.mjs'), RECORD)
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nran.log\n*.pid\n')
    writeFileSync(join(repo, 'README.md'), 'scratch\n')
    if (modules) linkModules(repo)
    ok(repo, ['add', '-A'])
    ok(repo, ['commit', '-q', '--no-verify', '-m', 'init'])
    ok(repo, ['remote', 'add', 'origin', join(dir, 'remote.git')])
    ok(repo, ['push', '-q', '--no-verify', 'origin', 'main'])
    ok(repo, ['fetch', '-q', 'origin'])
    if (installHooks) {
      const result = node(repo, ['scripts/git-hooks.mjs', '--install'])
      if (result.status !== 0) throw new Error(`--install failed in ${repo}: ${both(result)}`)
    }
    return { dir, repo }
  }
  const commit = (repo, file, text, extra) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), text)
    ok(repo, ['add', file])
    return g(repo, ['commit', '-q', '-m', `add ${file}`], extra)
  }
  const check = async (name, body) => {
    try {
      const detail = await body()
      record(name, true, detail)
    } catch (error) {
      record(name, false, error.message)
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  let controlHeld = false
  await check('control: a commit and a push run the jobs their files match, and pass', () => {
    const { repo } = scratch()
    clear(repo)
    const committed = commit(repo, 'docs/notes.md', 'notes\n')
    expect(committed.status === 0, `the commit failed: ${both(committed)}`)
    const jobs = ran(repo)
    const mdOnly = jobs.find((job) => job.name === 'md-only')
    expect(mdOnly && mdOnly.args.join(' ') === 'docs/notes.md', `md-only did not get the staged file: ${JSON.stringify(jobs)}`)
    expect(!jobs.some((job) => job.name === 'txt-only'), 'txt-only ran though no .txt was staged')
    expect(/1 job\(s\) skipped: the commit stages none of their files \(txt-only\)/.test(both(committed)), `the skip was not printed: ${both(committed)}`)
    const message = jobs.find((job) => job.name === 'prepare-commit-msg')
    expect(message && /COMMIT_EDITMSG$/.test(message.args[0]) && message.args[1] === 'message', `prepare-commit-msg did not get {1} {2}: ${JSON.stringify(message)}`)
    clear(repo)
    ok(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'docs/more.md', 'more\n')
    clear(repo)
    const pushed = g(repo, ['push', '-u', 'origin', 'feature'])
    const output = both(pushed)
    expect(pushed.status === 0, `the push failed: ${output}`)
    const names = ran(repo).map((job) => job.name).sort()
    expect(names.join(',') === 'always,docs', `the push ran ${names.join(',')}, not always,docs`)
    const always = ran(repo).find((job) => job.name === 'always')
    expect(always.args.join(' ') === `origin ${join(dirname(repo), 'remote.git')}` && always.mark === 'set', `always did not get {1} {2} and its env: ${JSON.stringify(always)}`)
    expect(/a new branch, so the files since its merge base with origin\/main/.test(output), `the range was not named: ${output}`)
    expect(/git-hooks pre-push: 3 job\(s\), 2 passed, 0 failed, 1 skipped/.test(output), `no total line: ${output}`)
    controlHeld = true
    return 'passes'
  })
  if (!controlHeld) {
    record('every case below', false, 'not run: the control failed, so none of them could be trusted')
    return
  }

  await check('the shipped pre-commit jobs allow a clean staged file', () => {
    const { repo } = scratch(readFileSync(join(REPO_ROOT, JOB_FILE), 'utf8'))
    const committed = commit(repo, 'clean.txt', 'clean\n')
    expect(committed.status === 0, `the shipped pre-commit jobs refused a clean commit: ${both(committed)}`)
    expect(/git-hooks pre-commit: .*0 failed/.test(both(committed)), `the shipped pre-commit jobs did not run: ${both(committed)}`)
    return 'plain commit passes'
  })

  await check('the shipped pre-commit jobs refuse whitespace errors in staged files', () => {
    const { repo } = scratch(readFileSync(join(REPO_ROOT, JOB_FILE), 'utf8'))
    const committed = commit(repo, 'whitespace.txt', 'trailing space \n')
    expect(committed.status !== 0 && /trailing whitespace/.test(both(committed)), `the staged whitespace error was not refused for its reason: ${both(committed)}`)
    expect(!ok(repo, ['ls-tree', '--name-only', 'HEAD']).includes('whitespace.txt'), 'the refused file reached HEAD')
    return 'staged whitespace refused'
  })

  await check('GIT_HOOKS_FORCE=1 runs a job whose glob matches nothing staged', () => {
    const { repo } = scratch()
    clear(repo)
    const committed = commit(repo, 'docs/a.md', 'a\n', { GIT_HOOKS_FORCE: '1' })
    expect(committed.status === 0, both(committed))
    const txt = ran(repo).find((job) => job.name === 'txt-only')
    expect(txt && txt.force === '1', `txt-only did not run forced: ${JSON.stringify(ran(repo))}`)
    return 'forced'
  })

  await check('GIT_HOOKS_SKIP=1 runs no job, and says so', () => {
    const { repo } = scratch()
    clear(repo)
    const committed = commit(repo, 'docs/a.md', 'a\n', { GIT_HOOKS_SKIP: '1' })
    expect(committed.status === 0, both(committed))
    expect(ran(repo).length === 0, `jobs ran: ${JSON.stringify(ran(repo))}`)
    expect(/GIT_HOOKS_SKIP=1, so no job ran/.test(both(committed)), `the skip was not said: ${both(committed)}`)
    return 'skipped, and said so'
  })

  await check('a push of an existing branch diffs from the remote, and a deletion pushes no files', () => {
    const { repo } = scratch()
    commit(repo, 'src/a.js', 'a\n')
    clear(repo)
    const pushed = g(repo, ['push', 'origin', 'main'])
    expect(pushed.status === 0, both(pushed))
    expect(/refs\/heads\/main: [0-9a-f]{7}\.\.[0-9a-f]{7}, 1 file\(s\)/.test(both(pushed)), `no range: ${both(pushed)}`)
    expect(ran(repo).map((job) => job.name).sort().join(',') === 'always,code', `ran ${JSON.stringify(ran(repo))}`)
    ok(repo, ['push', '-q', '--no-verify', 'origin', 'main:gone'])
    clear(repo)
    const deleted = g(repo, ['push', 'origin', '--delete', 'gone'])
    expect(deleted.status === 0, both(deleted))
    expect(/refs\/heads\/gone: deleted, so no files/.test(both(deleted)), `the deletion was not named: ${both(deleted)}`)
    expect(ran(repo).map((job) => job.name).join(',') === 'always', `a deletion ran ${JSON.stringify(ran(repo))}`)
    return 'diffed, and the deletion pushed nothing'
  })

  await check("a remote object missing here takes every tracked file", () => {
    const { dir, repo } = scratch()
    const head = ok(repo, ['rev-parse', 'HEAD']).trim()
    const stdin = join(dir, 'stdin')
    writeFileSync(stdin, `refs/heads/main ${head} refs/heads/main ${'1'.repeat(40)}\n`)
    clear(repo)
    const run = g(repo, ['hook', 'run', `--to-stdin=${stdin}`, 'pre-push', '--', 'origin', 'url'])
    expect(run.status === 0, both(run))
    expect(/the remote's 1111111 is not in this repository, so every tracked file/.test(both(run)), both(run))
    return 'every tracked file'
  })

  await check('an empty standard input says nothing was pushed, and runs only the jobs with no glob', () => {
    const { repo } = scratch()
    clear(repo)
    const run = g(repo, ['hook', 'run', 'pre-push', '--', 'origin', 'url'])
    expect(run.status === 0, both(run))
    expect(/standard input named no ref: nothing was pushed/.test(both(run)), both(run))
    expect(/2 job\(s\) skipped: the push changed none of their files \(docs, code\)/.test(both(run)), both(run))
    expect(ran(repo).map((job) => job.name).join(',') === 'always', JSON.stringify(ran(repo)))
    return 'said so'
  })

  await check('a failing job in a sequential group lets its sibling run, and fails the push', () => {
    const jobs = FIXTURE_JOBS.replace(
      "    - name: code\n      glob: 'src/**'\n      run: node record.mjs code\n",
      '    - name: suite\n      group:\n        parallel: false\n        jobs:\n          - name: first\n            run: node record.mjs first --exit 3\n          - name: second\n            run: node record.mjs second\n',
    )
    const { repo } = scratch(jobs)
    commit(repo, 'docs/a.md', 'a\n')
    clear(repo)
    const pushed = g(repo, ['push', 'origin', 'main'])
    expect(pushed.status !== 0, 'the push succeeded with a failing job')
    expect(/FAIL  suite\/first\s+[0-9.]+ s, exit 3/.test(both(pushed)), both(pushed))
    expect(ran(repo).some((job) => job.name === 'second'), 'the second job of the group did not run')
    expect(/: the run fails/.test(both(pushed)), both(pushed))
    return 'the sibling ran, and the push failed'
  })

  await check('a failing pre-commit job refuses the commit', () => {
    const jobs = FIXTURE_JOBS.replace('run: node record.mjs md-only {staged_files}', 'run: node record.mjs md-only --exit 1')
    const { repo } = scratch(jobs)
    const before = ok(repo, ['rev-parse', 'HEAD'])
    const committed = commit(repo, 'docs/a.md', 'a\n')
    expect(committed.status !== 0, 'the commit went through')
    expect(ok(repo, ['rev-parse', 'HEAD']) === before, 'HEAD moved')
    return 'refused'
  })

  await check("a failing job's output stops at the policy's cap, and the whole of it is in a file", () => {
    const cap = readCap(REPO_ROOT)
    const jobs = FIXTURE_JOBS.replace('run: node record.mjs md-only {staged_files}', `run: node record.mjs md-only --print ${cap * 3} --exit 1`)
    const { repo } = scratch(jobs)
    const committed = commit(repo, 'docs/a.md', 'a\n')
    const output = both(committed)
    expect(committed.status !== 0, 'the commit went through')
    const said = new RegExp(`the last ${cap} of its (\\d+) bytes; all of them are in (\\S+\\.log)`).exec(output)
    expect(said, `the cap was not named: ${output.slice(0, 400)}`)
    expect(output.includes('END') && !output.includes('BEGIN'), 'the printed tail is not the end of the output')
    expect(Buffer.byteLength(output) < cap + 2048, `it printed ${Buffer.byteLength(output)} bytes, over the cap of ${cap}`)
    expect(statSync(said[2]).size === Number(said[1]) && Number(said[1]) > cap * 3, 'the log file does not hold all of it')
    rmSync(dirname(said[2]), { recursive: true, force: true })
    return `${Buffer.byteLength(output)} bytes printed of ${said[1]}`
  })

  await check('post-checkout and post-merge get their arguments', () => {
    const { repo } = scratch()
    const main = ok(repo, ['rev-parse', 'HEAD']).trim()
    clear(repo)
    ok(repo, ['checkout', '-q', '-b', 'side'])
    const checkout = ran(repo).find((job) => job.name === 'post-checkout')
    expect(checkout && checkout.args.join(' ') === `${main} ${main} 1`, JSON.stringify(ran(repo)))
    commit(repo, 'docs/side.md', 'side\n')
    ok(repo, ['checkout', '-q', 'main'])
    clear(repo)
    ok(repo, ['merge', '-q', '--ff-only', 'side'])
    const merge = ran(repo).find((job) => job.name === 'post-merge')
    expect(merge && merge.args.join(' ') === '0', JSON.stringify(ran(repo)))
    return '{1} to {3} reach the jobs'
  })

  await check("a push from a linked worktree runs that worktree's copy, and a worktree with no node_modules is still made", () => {
    const { dir, repo } = scratch()
    const wt = join(dir, 'wt')
    const added = g(repo, ['worktree', 'add', '-q', '-b', 'wtb', wt])
    expect(added.status === 0, `git worktree add failed: ${both(added)}`)
    expect(/post-checkout: js-yaml cannot be loaded .*; its jobs did not run/.test(both(added)), `the missing node_modules was not said: ${both(added)}`)
    writeFileSync(join(wt, 'docs.md'), 'x\n')
    ok(wt, ['add', 'docs.md'])
    const refused = g(wt, ['commit', '-q', '-m', 'no modules'])
    expect(refused.status !== 0 && /pre-commit: refused\. js-yaml cannot be loaded/.test(both(refused)), `a commit with no node_modules was not refused: ${both(refused)}`)
    linkModules(wt)
    writeFileSync(join(wt, JOB_FILE), `${FIXTURE_JOBS}    - name: only-in-worktree\n      run: node record.mjs only-in-worktree\n`)
    ok(wt, ['add', JOB_FILE])
    ok(wt, ['commit', '-q', '-m', 'worktree jobs'])
    clear(wt)
    const pushed = g(wt, ['push', '-u', 'origin', 'wtb'])
    expect(pushed.status === 0, both(pushed))
    expect(ran(wt).some((job) => job.name === 'only-in-worktree'), `the worktree's job file was not read: ${both(pushed)}`)
    const leaked = ran(wt).filter((job) => job.gitDir !== null)
    expect(leaked.length === 0, `a job got the push's GIT_DIR, so its git would answer for this repository: ${JSON.stringify(leaked)}`)
    writeFileSync(join(wt, 'docs.md'), 'y\n')
    clear(wt)
    ok(wt, ['commit', '-q', '-a', '-m', 'all'])
    const staged = ran(wt).find((job) => job.name === 'md-only')
    expect(staged && /worktrees[/\\]wt[/\\]index\.lock$/.test(staged.index ?? ''), `pre-commit did not get the index \`git commit -a\` names, so it would check what was staged before: ${JSON.stringify(staged)}`)
    return "the worktree's runner ran, no job got GIT_DIR, and pre-commit got commit -a's index"
  })

  await check('the install writes the five entries, removes a lefthook shim, leaves a backup, and warns of the tracker\'s hook', () => {
    const { repo } = scratch(FIXTURE_JOBS, { installHooks: false })
    const hooks = join(repo, '.git', 'hooks')
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\ncall_lefthook()\n{\n  lefthook "$@"\n}\ncall_lefthook run "pre-push" "$@"\n')
    writeFileSync(join(hooks, 'pre-push.backup'), '#!/bin/sh\ncall_lefthook run "pre-push" "$@"\n')
    writeFileSync(join(hooks, 'post-merge'), '#!/usr/bin/env sh\n# --- BEGIN BEADS INTEGRATION v1.3.0 ---\n# --- END BEADS INTEGRATION v1.3.0 ---\n')
    const first = node(repo, ['scripts/git-hooks.mjs', '--install'])
    const output = both(first)
    expect(first.status === 0, output)
    for (const event of EVENTS) {
      expect(ok(repo, ['config', '--local', '--get', `hook.${HOOK_PREFIX}${event}.command`]).trim() === commandFor(event), `no command for ${event}`)
      expect(ok(repo, ['config', '--local', '--get', `hook.${HOOK_PREFIX}${event}.event`]).trim() === event, `no event for ${event}`)
    }
    expect(!existsSync(join(hooks, 'pre-push')) && /removed   .*pre-push: a lefthook shim/.test(output), output)
    expect(existsSync(join(hooks, 'pre-push.backup')) && /left      .*pre-push\.backup: a copy Git never runs/.test(output), output)
    expect(existsSync(join(hooks, 'post-merge')) && /post-merge: the tracker's own hook/.test(output), output)
    const second = both(node(repo, ['scripts/git-hooks.mjs', '--install']))
    expect(!/wrote/.test(second) && /unchanged hook\.asdlc-pre-push\.command/.test(second), `a second install wrote again: ${second}`)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ncall_lefthook run "pre-commit" "$@"\n')
    const committed = commit(repo, 'docs/a.md', 'a\n')
    expect(/pre-commit: warning: .*pre-commit is a lefthook shim/.test(both(committed)), `a shim that came back was not named: ${both(committed)}`)
    return 'written once, the shim removed, the rest reported'
  })

  await check("a commit names the tracker's own hook in .git/hooks, which runs bd a second time", () => {
    const { repo } = scratch()
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\n# --- BEGIN BEADS INTEGRATION v1.3.0 ---\n# --- END BEADS INTEGRATION v1.3.0 ---\nexit 0\n',
      { mode: 0o755 },
    )
    const committed = commit(repo, 'docs/a.md', 'a\n')
    expect(committed.status === 0, both(committed))
    expect(
      /pre-commit: warning: .*pre-commit carries the tracker's own hook, so bd runs a second time/.test(both(committed)),
      `the tracker's hook was not named: ${both(committed)}`,
    )
    return 'named'
  })

  await check('a gating event with no block in the job file refuses the commit', () => {
    const { repo } = scratch(FIXTURE_JOBS.slice(FIXTURE_JOBS.indexOf('prepare-commit-msg:')))
    const committed = commit(repo, 'docs/a.md', 'a\n')
    expect(
      committed.status !== 0 && /pre-commit: refused\. git-hooks\.yml has no `pre-commit` block/.test(both(committed)),
      `a commit with no pre-commit block was not refused: ${both(committed)}`,
    )
    return 'refused'
  })

  await check('--prepare installs nothing when CI is set', () => {
    const { repo } = scratch(FIXTURE_JOBS, { installHooks: false })
    const run = node(repo, ['scripts/git-hooks.mjs', '--prepare'], { CI: 'true' })
    expect(run.status === 0 && /CI is set, so no hook is installed/.test(both(run)), both(run))
    expect(g(repo, ['config', '--local', '--get', `hook.${HOOK_PREFIX}pre-push.command`]).status !== 0, 'a hook was written')
    return 'nothing written'
  })

  await check('gates refuses a checkout whose hooks are not installed, and names the fix', () => {
    const { repo } = scratch(FIXTURE_JOBS, { installHooks: false })
    const run = node(repo, ['scripts/git-hooks.mjs', '--gates'])
    expect(run.status !== 0 && /Run `mise run hooks:install`/.test(both(run)), both(run))
    return 'refused'
  })

  await check('gates runs the pre-push suite through Git, forced, and fails when a job fails', () => {
    const { repo } = scratch()
    clear(repo)
    const passing = node(repo, ['scripts/git-hooks.mjs', '--gates'])
    expect(passing.status === 0, both(passing))
    expect(ran(repo).map((job) => job.name).sort().join(',') === 'always,code,docs', `gates ran ${JSON.stringify(ran(repo))}`)
    expect(ran(repo).every((job) => job.force === '1'), 'gates did not force')
    writeFileSync(join(repo, JOB_FILE), FIXTURE_JOBS.replace('run: node record.mjs code', 'run: node record.mjs code --exit 1'))
    const failing = node(repo, ['scripts/git-hooks.mjs', '--gates'])
    expect(failing.status !== 0 && /FAIL  code/.test(both(failing)), both(failing))
    return 'forced through Git, and its status passed on'
  })

  if (process.platform === 'win32') {
    record('an older Git is refused, and nothing is written', true, 'skipped on Windows: the fake Git is a shell script')
    record('a signal kills every job', true, 'skipped on Windows: it sends a POSIX signal')
    record('the signal case reads a zombie as exited, and a process that runs as running', true, 'skipped on Windows: the reading is of /proc')
    return
  }

  await check('an older Git is refused, and nothing is written', () => {
    const { dir, repo } = scratch(FIXTURE_JOBS, { installHooks: false })
    const fake = join(dir, 'fake-bin')
    mkdirSync(fake)
    writeFileSync(join(fake, 'git'), '#!/bin/sh\necho "git version 2.51.1"\n', { mode: 0o755 })
    const old = { PATH: `${fake}:${env.PATH}` }
    const installed = node(repo, ['scripts/git-hooks.mjs', '--install'], old)
    expect(installed.status !== 0 && /Git 2\.51\.1 is older than 2\.54\.0/.test(both(installed)), both(installed))
    expect(g(repo, ['config', '--local', '--get', `hook.${HOOK_PREFIX}pre-push.command`]).status !== 0, 'a hook was written')
    const gated = node(repo, ['scripts/git-hooks.mjs', '--gates'], old)
    expect(gated.status !== 0 && /Git 2\.51\.1 is older than 2\.54\.0/.test(both(gated)), both(gated))
    return 'refused by name'
  })

  await check('a signal kills every job', async () => {
    const jobs = FIXTURE_JOBS.replace('run: node record.mjs always {1} {2}', 'run: node record.mjs sleeper --sleep 30000')
    const { repo } = scratch(jobs)
    const child = spawn(process.execPath, ['scripts/git-hooks.mjs', 'pre-push'], {
      cwd: repo,
      env: { ...env, GIT_HOOKS_FORCE: '1' },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.stdin.end()
    const pidFile = join(repo, 'sleeper.pid')
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(pidFile), 'the job never started')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const exited = new Promise((r) => child.on('close', r))
    child.kill('SIGTERM')
    await exited
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      alive = pidRuns(pid)
      if (alive) await new Promise((r) => setTimeout(r, 50))
    }
    if (alive) process.kill(pid, 'SIGKILL')
    expect(!alive, 'the job outlived the runner')
    return 'no job outlived it'
  })

  await check('the signal case reads a zombie as exited, and a process that runs as running', async () => {
    if (process.platform !== 'linux') return 'skipped off Linux: the reading is of /proc'
    // The exec'd sleep never reaps the child sh started in the background, which stays a zombie
    // wherever PID 1 reaps orphans too.
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const zombie = await new Promise((r) => parent.stdout.once('data', (d) => r(Number(String(d).trim()))))
      const state = () => {
        try {
          const stat = readFileSync(`/proc/${zombie}/stat`, 'utf8')
          return stat[stat.lastIndexOf(')') + 2]
        } catch {
          return null
        }
      }
      for (let i = 0; i < 40 && state() !== 'Z'; i++) await new Promise((r) => setTimeout(r, 50))
      expect(state() === 'Z', `the child ${zombie} never became a zombie`)
      expect(!pidRuns(zombie), `the zombie ${zombie} reads as running`)
      expect(pidRuns(parent.pid), `the sleeping parent ${parent.pid} reads as exited`)
      return 'the zombie reads as exited, the sleeping parent as running'
    } finally {
      parent.kill('SIGKILL')
    }
  })
}

process.exitCode = await main()

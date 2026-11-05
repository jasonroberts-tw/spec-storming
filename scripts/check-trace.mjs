/**
 * Checks one feature's traceability (AGENTS.md § Delivery workflow): every acceptance criterion its
 * spec defines is cited by a story under it in the tracker, and by a test or a manual-verify item in
 * the spec's test plan, and, once the stories are done, named by a tracked file outside the paths a
 * branch writes before approval (`beforeApprovalPaths`); every story cites one of the spec's criteria
 * or names its enabler. It prints one line per gap and exits 1 on any.
 *
 * THE FAILURE THIS PREVENTS. No incident yet. Were it wrong, a feature could reach Review with a
 * criterion no story built and no test checks, and the reviewer, reading the stories rather than the
 * spec, would pass it: the gap a test plan exists to close, found by the operator in production.
 *
 * WHAT IT READS. A criterion is an ID of the form `AC-<code>-<n>` (the `refine` skill § 4) in the
 * spec's `## Acceptance criteria` section. The test plan is its `## Test plan` section, and an ID on a
 * line there that says `manual-verify` is checked by the operator, not by a test. A story cites an ID
 * anywhere in its title, description, acceptance criteria, design or notes, and an enabler story has
 * a line opening `Enabler:` (the `plan-stories` skill § 2). `--plan` leaves out the test-file leg,
 * for the run right after the stories are filed, before any test exists.
 *
 *   node scripts/check-trace.mjs <feature id> [--plan]
 *   TRACE_CHECK_ROOT=<dir> node scripts/check-trace.mjs <feature id>   over a doctored checkout
 *   mise run trace:selftest                                             (--selftest)
 *
 * Needs `bd` on PATH, which it starts twice, and `git`, once. With no `bd`, or one that fails, it
 * exits 2 and says why: a caller asked about one feature, so an unanswered question is not a pass.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeLauncher, resolveBd, runBd } from '../tools/lib/bd-launcher.ts'
import { SCRATCH_GIT_ENV, gitEnv } from '../tools/lib/git-env.ts'
import { readPolicy } from '../tools/lib/policy.ts'

const ROOT_ENV = 'TRACE_CHECK_ROOT'
const ID = /\bAC-[A-Za-z0-9]+-\d+\b/g

/** The IDs in the lines under each `## ` heading the test names, and which of the test plan's are manual. */
function readSpec(text) {
  const criteria = new Set()
  const planned = new Set()
  const manual = new Set()
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = heading[1].toLowerCase()
      continue
    }
    const ids = line.match(ID) ?? []
    if (section === 'acceptance criteria') for (const id of ids) criteria.add(id)
    if (section === 'test plan') {
      for (const id of ids) planned.add(id)
      if (/manual-verify/i.test(line)) for (const id of ids) manual.add(id)
    }
  }
  return { criteria, planned, manual }
}

/** Every gap between a spec, its stories and the IDs tracked files name, as lines. */
export function trace({ specText, specPath, stories, namedIds = null }) {
  const { criteria, planned, manual } = readSpec(specText)
  const gaps = []
  if (criteria.size === 0) gaps.push(`${specPath}: its ## Acceptance criteria section defines no AC-<code>-<n> ID`)
  const cited = new Map()
  for (const story of stories) {
    const text = [story.title, story.description, story.acceptance_criteria, story.design, story.notes].join('\n')
    const ids = new Set(text.match(ID) ?? [])
    for (const id of ids) {
      if (criteria.has(id)) cited.set(id, [...(cited.get(id) ?? []), story.id])
      else gaps.push(`${story.id}: cites ${id}, which ${specPath} does not define`)
    }
    if (![...ids].some((id) => criteria.has(id)) && !/^\s*Enabler:/im.test(text)) {
      gaps.push(`${story.id}: cites none of the criteria and names no enabler`)
    }
  }
  for (const id of criteria) {
    if (!cited.has(id)) gaps.push(`${id}: no story cites it`)
    if (!planned.has(id)) gaps.push(`${id}: the test plan names no test or manual-verify item for it`)
    if (namedIds !== null && !manual.has(id) && !namedIds.has(id)) gaps.push(`${id}: no tracked test names it`)
  }
  return { gaps, criteria: criteria.size, stories: stories.length }
}

function bdJson(launcher, root, args) {
  const r = runBd(launcher, [...args, '--json'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } })
  if (r.error || r.status !== 0) {
    throw new Error(`\`bd ${args.join(' ')}\` through ${describeLauncher(launcher)} failed: ${r.error?.message ?? r.stderr.trim()}`)
  }
  return JSON.parse(r.stdout)
}

function run(argv) {
  const root = resolve(process.env[ROOT_ENV] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const featureId = argv.find((arg) => !arg.startsWith('--'))
  if (!featureId) throw new Error('usage: node scripts/check-trace.mjs <feature id> [--plan]')
  const resolved = resolveBd()
  if (!resolved.found || !resolved.runnable) throw new Error(`this check needs \`bd\`: ${resolved.reason}`)
  const feature = [].concat(bdJson(resolved.launcher, root, ['show', featureId]))[0]
  if (!feature?.spec_id) throw new Error(`${featureId} has no spec; link it with \`bd update ${featureId} --spec-id <path>\``)
  const stories = [].concat(bdJson(resolved.launcher, root, ['children', featureId]))
  let namedIds = null
  if (!argv.includes('--plan')) {
    const policy = readPolicy(root)
    const skip = [...(policy.beforeApprovalPaths ?? []), policy.specDirectory].filter(Boolean)
    const grep = spawnSync('git', ['grep', '-h', '-o', '-w', '-E', 'AC-[A-Za-z0-9]+-[0-9]+', '--', '.', ...skip.map((p) => `:(exclude)${p}`)], {
      cwd: root, env: gitEnv(), encoding: 'utf8',
    })
    if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep failed: ${grep.stderr.trim()}`)
    namedIds = new Set(grep.stdout.split('\n').filter(Boolean))
  }
  const specText = readFileSync(join(root, feature.spec_id), 'utf8')
  const result = trace({ specText, specPath: feature.spec_id, stories, namedIds })
  for (const gap of result.gaps) console.log(`trace: ${gap}`)
  console.log(
    `trace: ${featureId}: ${result.criteria} criteria, ${result.stories} stories, ${result.gaps.length} gaps` +
      (namedIds === null ? ' (--plan: tests not read)' : ''),
  )
  return result.gaps.length ? 1 : 0
}

function selftest() {
  let failures = 0
  const check = (label, condition, detail) => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || !detail ? '' : ` -- ${detail}`}`)
    if (!condition) failures += 1
  }
  const SPEC = [
    '# Feature', '', '## Acceptance criteria', '', '- AC-IP-1: Given a file, when opened, then it shows.',
    '- AC-IP-2: Given no file, when opened, then it says so.', '', '## Test plan', '',
    '| Layer | Covers | Path |', '|---|---|---|', '| Functional | AC-IP-1 | tests/open.test.mjs |',
    '| manual-verify | AC-IP-2 | the operator opens nothing |', '',
  ].join('\n')
  const STORIES = [
    { id: 's1', title: 'Open a file', description: 'Satisfies AC-IP-1.' },
    { id: 's2', title: 'Empty state', acceptance_criteria: 'AC-IP-2 holds' },
    { id: 's0', title: 'Walking skeleton', description: 'Enabler: the walking skeleton' },
  ]
  const NAMED = new Set(['AC-IP-1'])
  const gapsOf = (change) => {
    const input = { specText: SPEC, specPath: 'docs/specs/f.md', stories: STORIES, namedIds: NAMED }
    change(input)
    return trace(input).gaps
  }
  const has = (gaps, text) => gaps.some((gap) => gap.includes(text))

  console.log('trace: the pure check')
  const control = gapsOf(() => {})
  check('control: a traced feature has no gap', control.length === 0, JSON.stringify(control))
  const orphan = gapsOf((i) => { i.stories = i.stories.filter((s) => s.id !== 's1') })
  check('a criterion no story cites is a gap', has(orphan, 'AC-IP-1: no story cites it'), JSON.stringify(orphan))
  const unplanned = gapsOf((i) => { i.specText = i.specText.replace('| Functional | AC-IP-1 |', '| Functional | |') })
  check('a criterion the test plan leaves out is a gap', has(unplanned, 'AC-IP-1: the test plan names no test'), JSON.stringify(unplanned))
  const untested = gapsOf((i) => { i.namedIds = new Set() })
  check('a criterion no tracked test names is a gap', has(untested, 'AC-IP-1: no tracked test names it'), JSON.stringify(untested))
  check('a manual-verify criterion needs no test', !has(untested, 'AC-IP-2: no tracked test'), JSON.stringify(untested))
  const planOnly = gapsOf((i) => { i.namedIds = null })
  check('--plan reads no tests', planOnly.length === 0, JSON.stringify(planOnly))
  const aimless = gapsOf((i) => { i.stories = [...i.stories, { id: 's3', title: 'Tidy' }] })
  check('a story with no criterion and no enabler is a gap', has(aimless, 's3: cites none'), JSON.stringify(aimless))
  const stray = gapsOf((i) => { i.stories = [...i.stories, { id: 's4', description: 'AC-IP-9' }] })
  check('a story citing an ID the spec does not define is a gap', has(stray, 's4: cites AC-IP-9'), JSON.stringify(stray))
  const empty = gapsOf((i) => { i.specText = '# Feature\n' })
  check('a spec with no criteria is a gap', has(empty, 'defines no AC-<code>-<n> ID'), JSON.stringify(empty))

  console.log('trace: end to end over a scratch checkout and a stub bd')
  const scratch = mkdtempSync(join(tmpdir(), 'trace-check-'))
  try {
    const root = join(scratch, 'checkout')
    const bin = join(scratch, 'bin')
    const put = (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const policy = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy')
    for (const file of ['delivery.json']) put(join(root, 'policy', file), readFileSync(join(policy, file), 'utf8'))
    put(join(root, 'docs', 'specs', 'f.md'), SPEC)
    put(join(root, 'tests', 'open.test.mjs'), "test('AC-IP-1 shows the file')\n")
    // SCRATCH_GIT_ENV, because a pre-push run inherits GIT_DIR, and git would answer for this repository.
    const git = (...args) => spawnSync('git', args, { cwd: root, env: SCRATCH_GIT_ENV, encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    put(join(bin, 'show.json'), JSON.stringify([{ id: 'f', spec_id: 'docs/specs/f.md' }]))
    put(join(bin, 'children.json'), JSON.stringify(STORIES))
    put(join(bin, 'bd'), `#!/bin/sh\n[ -n "$STUB_BD_FAIL" ] && { echo broken >&2; exit 1; }\ncat "${bin}/$1.json"\n`)
    chmodSync(join(bin, 'bd'), 0o755)
    const cli = (env = {}, ...args) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'f', ...args], {
      encoding: 'utf8', env: { ...SCRATCH_GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, [ROOT_ENV]: root, ...env },
    })
    const ok = cli()
    check('control: the command exits 0 and counts what it read', ok.status === 0 && ok.stdout.includes('2 criteria, 3 stories, 0 gaps'), ok.stdout + ok.stderr)
    rmSync(join(root, 'tests', 'open.test.mjs'))
    git('add', '-A')
    const gap = cli()
    check('a removed test makes the command exit 1, naming the criterion', gap.status === 1 && gap.stdout.includes('AC-IP-1: no tracked test names it'), gap.stdout)
    const broken = cli({ STUB_BD_FAIL: '1' })
    check('a bd that fails makes the command exit 2, saying so', broken.status === 2 && broken.stderr.includes('failed: broken'), broken.stderr)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(failures ? `trace selftest: ${failures} failure(s)` : 'trace selftest: every case passed')
  return failures ? 1 : 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  try {
    process.exit(argv.includes('--selftest') ? selftest() : run(argv))
  } catch (error) {
    console.error(`trace: ${error.message}`)
    process.exit(2)
  }
}

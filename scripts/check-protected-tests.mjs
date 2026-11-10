/**
 * The protected-tests gate (AGENTS.md § Delivery workflow). At pre-push and in CI it holds what the
 * edit hook cannot see, and it answers the reviewer's question about every listed test in one
 * command.
 *
 * `scripts/hooks/guard-delivery.mjs` refuses an edit to a protected test that a session makes with
 * an edit tool. A change made through the shell, by a formatter or by moving the file gets past an
 * edit hook, and so does a line of the list that names no file.
 *
 * WHAT IT REFUSES. It reads the list `protectedTestsFile` names (`policy/delivery.json`) as HEAD has
 * it and as `origin/main` has it:
 *
 *   1. a line of HEAD's list that is not `<path> <issue id>`;
 *   2. a path HEAD's list names that HEAD does not hold: a test deleted, moved or mistyped;
 *   3. a test `origin/main` lists, still listed at HEAD for the same issue, whose content at HEAD
 *      is not `origin/main`'s: a protected test changed on this branch.
 *
 * WHAT IT REPORTS AND DOES NOT REFUSE.
 *
 *   - A line `origin/main` holds that HEAD's list lacks, with the commit that took it out and that
 *     commit's author. Deleting the line is how the operator lifts a protection, and a commit's
 *     author is a default a session can set, so the gate cannot tell the operator's commit from a
 *     session's. The `spec-reviewer` agent and the pull request's reader judge that line.
 *   - A test `origin/main` lists that HEAD lists for another issue. That is the change the
 *     operator approved, listed again by the issue that made it, so the test stays protected once
 *     this branch merges.
 *   - Each test this branch lists, with the commit that listed it and each later commit that
 *     changed it. A test is protected from its merge, so its own branch may correct it, and the
 *     reviewer reads those commits.
 *
 * THE FAILURE THIS PREVENTS. No incident yet for the three refusals: until 2026-11-10 nothing but
 * the reviewer read the list, so a mistyped line protected nothing and said nothing. The report has
 * one. In a Target, the reviewer answered this question with a loop of git commands over the list,
 * and Claude Code's worktree isolation refused that loop again and again (the worktree briefing
 * says which forms it refuses). `mise run protected-tests:check` is one plain command.
 *
 * WHAT IT DOES NOT DO. It does not check that the suite runs a listed test: each project names its
 * own runner, so a glob that skips a test file gets past it. It does not read a helper or a fixture
 * a listed test relies on. With no `origin/main`, as in a checkout with no remote, it holds rules 1
 * and 2 and says it compared nothing.
 *
 *   node scripts/check-protected-tests.mjs                      (mise run protected-tests:check)
 *   node scripts/check-protected-tests.mjs --selftest           (mise run protected-tests:selftest)
 *   PROTECTED_TESTS_ROOT=<dir> node scripts/check-protected-tests.mjs    over another checkout
 *
 * Exit 0 with nothing refused, 1 with a refusal, 2 when it cannot read the policy or run git. Needs
 * `git`: five calls, one more for each line that left the list, and two more for each test the
 * branch lists.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRATCH_GIT_ENV, gitEnv } from '../tools/lib/git-env.ts'
import { readPolicy } from '../tools/lib/policy.ts'

const ROOT_ENV = 'PROTECTED_TESTS_ROOT'
const TRUNK = 'origin/main'

/** A list's text as its entries and its malformed lines. A line is `<path> <issue id>`; `#` opens a comment. */
export function parseList(text) {
  const entries = new Map()
  const malformed = []
  for (const [index, raw] of (text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length !== 2) malformed.push({ number: index + 1, line })
    else entries.set(fields[0], fields[1])
  }
  return { entries, malformed }
}

/**
 * What the gate finds, from the two lists and the two trees. `headFiles` and `trunkFiles` map each
 * tracked path to its blob id; `trunk` is null where the checkout has no `origin/main`.
 */
export function judge({ head, trunk, headFiles, trunkFiles }) {
  const refusals = []
  const rows = []
  for (const { number, line } of head.malformed) {
    refusals.push(`line ${number} of the list is not \`<path> <issue id>\`: ${JSON.stringify(line)}`)
  }
  const merged = trunk?.entries ?? new Map()
  for (const [path, issue] of head.entries) {
    if (!headFiles.has(path)) {
      rows.push({ state: 'MISSING', path, issue })
      refusals.push(`${path} (${issue}) is listed, and HEAD holds no such file: a test deleted, moved or mistyped`)
    } else if (!merged.has(path)) {
      rows.push({ state: 'listed here', path, issue })
    } else if (merged.get(path) !== issue) {
      rows.push({ state: 'listed anew', path, issue, was: merged.get(path) })
    } else if (trunkFiles.has(path) && trunkFiles.get(path) !== headFiles.get(path)) {
      rows.push({ state: 'CHANGED', path, issue })
      refusals.push(`${path} (${issue}) is protected on ${TRUNK}, and this branch changed it`)
    } else {
      rows.push({ state: 'unchanged', path, issue })
    }
  }
  for (const [path, issue] of merged) if (!head.entries.has(path)) rows.push({ state: 'lifted', path, issue })
  return { refusals, rows }
}

/** A git call in `root` that answers with its output, or null when it fails. */
function gitIn(root) {
  return (...args) => {
    const r = spawnSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error) throw new Error(`git could not run: ${r.error.message}`)
    return r.status === 0 ? r.stdout : null
  }
}

/** Every tracked path of a revision, mapped to its blob id. */
function filesAt(git, rev) {
  const files = new Map()
  for (const row of (git('ls-tree', '-r', '-z', rev) ?? '').split('\0')) {
    const tab = row.indexOf('\t')
    if (tab !== -1) files.set(row.slice(tab + 1), row.slice(0, tab).split(' ')[2])
  }
  return files
}

function run() {
  const root = resolve(process.env[ROOT_ENV] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const listFile = readPolicy(root).protectedTestsFile
  if (typeof listFile !== 'string' || listFile === '') throw new Error('`protectedTestsFile` is not set in policy/delivery.json')
  const git = gitIn(root)
  if (git('rev-parse', '--verify', '--quiet', 'HEAD') === null) throw new Error(`${root} has no commit to read`)
  const hasTrunk = git('rev-parse', '--verify', '--quiet', `refs/remotes/${TRUNK}`) !== null
  const head = parseList(git('show', `HEAD:${listFile}`))
  const trunk = hasTrunk ? parseList(git('show', `${TRUNK}:${listFile}`)) : null
  const { refusals, rows } = judge({
    head,
    trunk,
    headFiles: filesAt(git, 'HEAD'),
    trunkFiles: hasTrunk ? filesAt(git, TRUNK) : new Map(),
  })

  const range = `${TRUNK}..HEAD`
  const shas = (text) => (text ?? '').split('\n').filter(Boolean)
  for (const row of rows) {
    let detail = ''
    if (row.state === 'lifted') {
      const [by] = shas(git('log', '-1', '--format=%h by %an <%ae>', `-S${row.path} `, range, '--', listFile))
      detail = `its line left the list in ${by ?? 'a commit this checkout cannot name'}`
    } else if (row.state === 'listed anew') {
      detail = `${TRUNK} lists it for ${row.was}`
    } else if (row.state === 'listed here' && hasTrunk) {
      const [listing] = shas(git('log', '--reverse', '--format=%h', `-S${row.path} `, range, '--', listFile))
      const since = listing ? shas(git('log', '--format=%h', `${listing}..HEAD`, '--', row.path)) : []
      detail = `listed in ${listing ?? 'no commit yet'}${since.length ? `; changed since in ${since.join(', ')}` : ''}`
    } else if (row.state === 'listed here') {
      detail = `there is no ${TRUNK} to tell a merged listing from this branch's`
    }
    console.log(`protected-tests: ${row.state.padEnd(11)} ${row.path} ${row.issue}${detail ? ` (${detail})` : ''}`)
  }
  for (const refusal of refusals) console.error(`protected-tests: refused. ${refusal}`)
  console.log(
    `protected-tests: ${head.entries.size} listed at HEAD in ${listFile}, ` +
      (hasTrunk ? `${trunk.entries.size} on ${TRUNK}` : `and no ${TRUNK} to compare with`) +
      `; ${refusals.length} refused.` +
      (refusals.length ? ' Only the operator approves a change to a protected test, by deleting its line in a commit of their own; the issue that then changes the test lists it again (AGENTS.md § Delivery workflow).' : ''),
  )
  return refusals.length ? 1 : 0
}

function selftest() {
  let failures = 0
  const check = (label, condition, detail) => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || !detail ? '' : ` -- ${detail}`}`)
    if (!condition) failures += 1
  }
  const scratch = mkdtempSync(join(tmpdir(), 'protected-tests-'))
  const root = join(scratch, 'checkout')
  const LIST = 'docs/specs/protected-tests.txt'
  const git = (...args) => execFileSync('git', args, { cwd: root, env: SCRATCH_GIT_ENV, encoding: 'utf8', stdio: 'pipe' })
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const commit = (message, who = 'A Session') => {
    git('add', '-A')
    git('-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase().replace(/\W+/g, '.')}@example.invalid`, 'commit', '-qm', message)
    return git('rev-parse', '--short', 'HEAD').trim()
  }
  const gate = () => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...SCRATCH_GIT_ENV, [ROOT_ENV]: root }, encoding: 'utf8',
    })
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', both: `${r.stdout}${r.stderr}` }
  }
  const said = (r) => `status=${r.status} ${JSON.stringify(r.both.slice(0, 400))}`
  try {
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: SCRATCH_GIT_ENV })
    write('policy/delivery.json', JSON.stringify({
      describes: 'd', whyThisFileExists: 'w', gatedBy: 'g', whatItDoesNOTDo: 'n', provenance: 'p',
      protectedTestsFile: LIST, protectedTestsFileMeans: 'm',
    }))
    write(LIST, '# protected tests\ntests/a.test.mjs demo-1\ntests/b.test.mjs demo-2\n')
    write('tests/a.test.mjs', 'test a\n')
    write('tests/b.test.mjs', 'test b\n')
    const base = commit('the trunk lists two tests')

    console.log('protected-tests: a checkout with no origin/main')
    const noTrunk = gate()
    check('control: with no origin/main the gate passes and says it compared nothing', noTrunk.status === 0 && noTrunk.out.includes('no origin/main to compare with'), said(noTrunk))
    write(LIST, '# protected tests\ntests/a.test.mjs demo-1\ntests/b.test.mjs demo-2\ntests/typo.test.mjs demo-3\n')
    commit('a line that names no file')
    const typo = gate()
    check('a listed path HEAD does not hold is refused, with no origin/main too', typo.status === 1 && typo.err.includes('tests/typo.test.mjs (demo-3) is listed, and HEAD holds no such file'), said(typo))
    git('reset', '-q', '--hard', base)

    console.log('protected-tests: a branch against origin/main')
    git('update-ref', 'refs/remotes/origin/main', base)
    const control = gate()
    check('control: a branch that changed no listed test passes', control.status === 0 && /unchanged\s+tests\/a\.test\.mjs demo-1/.test(control.out) && control.out.includes('2 on origin/main; 0 refused'), said(control))

    write('tests/a.test.mjs', 'test a, weakened\n')
    commit('a merged test changed through the shell')
    const changed = gate()
    check('a test origin/main lists, changed on the branch, is refused', changed.status === 1 && changed.err.includes('tests/a.test.mjs (demo-1) is protected on origin/main, and this branch changed it'), said(changed))
    check('and the refusal says who may approve the change', changed.out.includes('Only the operator approves a change to a protected test'), said(changed))

    write(LIST, '# protected tests\ntests/b.test.mjs demo-2\n')
    const lift = commit('lift the protection of a', 'An Operator')
    const lifted = gate()
    check(
      'once its line has left the list, the change passes, and the report names the commit and its author',
      lifted.status === 0 && lifted.out.includes(`lifted      tests/a.test.mjs demo-1 (its line left the list in ${lift} by An Operator <an.operator@example.invalid>)`),
      said(lifted),
    )
    write(LIST, '# protected tests\ntests/b.test.mjs demo-2\ntests/a.test.mjs demo-9\n')
    commit('list a again, for the issue that changed it')
    const anew = gate()
    check(
      'listed again for another issue, the changed test passes, and the report names the issue origin/main has',
      anew.status === 0 && anew.out.includes('listed anew tests/a.test.mjs demo-9 (origin/main lists it for demo-1)'),
      said(anew),
    )
    git('reset', '-q', '--hard', base)

    git('mv', 'tests/b.test.mjs', 'tests/b.moved.test.mjs')
    commit('a merged test moved')
    const moved = gate()
    check('a listed test that was moved is refused as missing', moved.status === 1 && moved.err.includes('tests/b.test.mjs (demo-2) is listed, and HEAD holds no such file'), said(moved))
    git('reset', '-q', '--hard', base)

    write(LIST, '# protected tests\ntests/a.test.mjs demo-1\ntests/b.test.mjs demo-2\nTests/A.test.mjs demo-4\n')
    commit('a line in another case than the file')
    const cased = gate()
    check('a line that names a file in another case is refused as missing', cased.status === 1 && cased.err.includes('Tests/A.test.mjs (demo-4) is listed, and HEAD holds no such file'), said(cased))
    git('reset', '-q', '--hard', base)

    write(LIST, '# protected tests\ntests/a.test.mjs demo-1\ntests/b.test.mjs demo-2\ntests/a.test.mjs\ntests/b.test.mjs demo-2 and more\n')
    commit('two lines that are not a path and an issue')
    const malformed = gate()
    check(
      'a line with one field, and one with three, are refused by their line numbers',
      malformed.status === 1 && malformed.err.includes('line 4 of the list is not `<path> <issue id>`') && malformed.err.includes('line 5 of the list is not `<path> <issue id>`'),
      said(malformed),
    )
    git('reset', '-q', '--hard', base)

    write('tests/c.test.mjs', 'test c\n')
    write(LIST, '# protected tests\ntests/a.test.mjs demo-1\ntests/b.test.mjs demo-2\ntests/c.test.mjs demo-5\n')
    const listing = commit('list c on the branch')
    const own = gate()
    check('a test the branch listed passes, and the report names the commit that listed it', own.status === 0 && own.out.includes(`listed here tests/c.test.mjs demo-5 (listed in ${listing})`), said(own))
    write('tests/c.test.mjs', 'test c, corrected\n')
    const correction = commit('correct c, which asserted the wrong status')
    const corrected = gate()
    check(
      'once the branch changes that test, the gate still passes and the report names the later commit',
      corrected.status === 0 && corrected.out.includes(`listed here tests/c.test.mjs demo-5 (listed in ${listing}; changed since in ${correction})`),
      said(corrected),
    )
    git('update-ref', 'refs/remotes/origin/main', correction)
    write('tests/c.test.mjs', 'test c, weakened after the merge\n')
    commit('change c after its listing merged')
    const afterMerge = gate()
    check('control: once the listing is on origin/main, a change to the same test is refused', afterMerge.status === 1 && afterMerge.err.includes('tests/c.test.mjs (demo-5) is protected on origin/main'), said(afterMerge))

    console.log('protected-tests: input it cannot read')
    git('reset', '-q', '--hard', base)
    git('rm', '-q', LIST)
    commit('no list at all')
    const noList = gate()
    check('a HEAD with no list passes, with nothing listed', noList.status === 0 && noList.out.includes('0 listed at HEAD'), said(noList))
    write('policy/delivery.json', JSON.stringify({
      describes: 'd', whyThisFileExists: 'w', gatedBy: 'g', whatItDoesNOTDo: 'n', provenance: 'p',
    }))
    const noKey = gate()
    check('a policy with no protectedTestsFile makes the gate exit 2, saying so', noKey.status === 2 && noKey.err.includes('`protectedTestsFile` is not set'), said(noKey))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(failures ? `protected-tests selftest: ${failures} failure(s)` : 'protected-tests selftest: every case passed')
  return failures ? 1 : 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exit(process.argv.includes('--selftest') ? selftest() : run())
  } catch (error) {
    console.error(`protected-tests: ${error.message}`)
    process.exit(2)
  }
}

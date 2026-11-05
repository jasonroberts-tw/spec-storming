/**
 * `mise run citations:selftest` -- does the citation scanner still BITE?
 *
 * A resolution gate has one characteristic failure and it is not a false alarm: it is going quietly
 * green. Narrow the regex by a character, resolve a path one strategy too eagerly, or let the
 * section matcher accept any line at all, and `citations:check` prints the same reassuring summary
 * over a repository it is no longer checking. Nothing in the repository's own citations would say
 * so, because the gate passing IS the expected outcome.
 *
 * So this holds the scanner to synthetic fixtures where the answer is known: every failure it is
 * supposed to catch, and -- just as important -- every shape it must NOT report, because a gate that
 * cries wolf is deleted and then checks nothing at all. Section 6 is the other half: the gate itself,
 * run end to end through `CITATIONS_ROOT` over a git tree built under the temporary directory, must
 * find exactly the citations that tree holds, and each doctored copy of the tree must fail for the
 * one reason it was doctored for.
 *
 * THE FAILURE THIS FILE HAD, dated 2026-09-23: nothing ran it. `package.json` had no
 * `citations:selftest`, so no pre-push job or CI step did, and run by hand it failed on a repository
 * the gate passed. Its repository-level floor asserted more than twenty `<file>.md:NN` citations in a
 * repository that legitimately has none, and its memory-rule fixtures asserted an exemption for the
 * tracker's generated block, which `MEMORY_EXEMPT_REGIONS` registers only once the block exists. A
 * floor on the repository's own content fails for a reason no commit repairs, and a fixture held to
 * the live registry breaks whenever the registry legitimately changes. Section 6 now counts a tree
 * whose answer is known by construction, and section 7 holds the region shapes to its own registry.
 *
 *   mise run citations:selftest
 *
 * Needs `git` on PATH, to build the synthetic tree; no `../sibling` checkout and no network.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnv } from '../lib/git-env.ts'
import type { ExemptRegion } from './memory.ts'
import {
  MEMORY_EXEMPT_REGIONS,
  describeRegion,
  exemptRegionsIn,
  inMemoryScope,
  memoryProblemsIn,
} from './memory.ts'
import {
  QUOTED,
  HISTORY,
  citationsIn,
  headingsOf,
  historyReason,
  indexByName,
  isQuoted,
  looksLikeSectionName,
  namesSection,
  resolveTarget,
  SCAN_ROOT,
  trackedFiles,
} from './scan.ts'

/**
 * The one element of `xs`, or a thrown error naming what was expected.
 *
 * A test helper rather than `xs[0]`, and the reason is worth recording: `tsc --noEmit` and
 * `@typescript-eslint/no-unnecessary-condition` disagree about whether an index or a `.find()` can
 * be undefined here, so every optional-chain spelling is rejected by one of the two. A length check
 * on a number is a condition neither disputes, and asserting exactly one is a stronger claim than
 * reading the first of several anyway.
 */
function only<T>(xs: readonly T[], what: string): T {
  if (xs.length !== 1) throw new Error(`expected exactly one ${what}, got ${xs.length}`)
  return xs[0] as T
}

let failures = 0
let checks = 0
const ok = (what: string, cond: boolean, detail = ''): void => {
  checks++
  if (cond) console.log(`  ok   ${what}`)
  else {
    failures++
    console.error(`  FAIL ${what}${detail ? ` -- ${detail}` : ''}`)
  }
}

console.log('citation scanner selftest\n')

/* --------------------------------------------------------------------------------------------- *
 * 1. What the line-citation regex must and must not see
 * --------------------------------------------------------------------------------------------- */

{
  const found = (text: string) => citationsIn('a/b.ts', text).filter((c) => c.kind === 'line')

  const one = only(found('see `foo.md:12` for the rule'), 'line citation')
  ok('a bare `<file>.md:NN` is a citation', one.target === 'foo.md' && one.first === 12)

  const ranged = only(found('`docs/foo.md:12-18` states it'), 'range citation')
  ok(
    'a range keeps both ends',
    ranged.first === 12 && ranged.last === 18,
    `got ${ranged.first}-${ranged.last}`,
  )

  ok(
    'a path with directories is kept whole',
    only(found('x `a/b/c.md:3`'), 'line citation').target === 'a/b/c.md',
  )

  // The continuation spelling `md:561, :583` names two lines. Only the first is matched, and that is
  // a documented floor -- but the `:583` must not be read as a citation to a file called `583`.
  ok('a `, :NN` continuation does not become a second citation', found('`a.md:5, :9`').length === 1)

  ok(
    'a line with no citation yields none',
    found('nothing here, just prose about foo.md').length === 0,
  )
}

/* --------------------------------------------------------------------------------------------- *
 * 2. Section citations, and the prose the scanner must decline to read as one
 * --------------------------------------------------------------------------------------------- */

{
  const sections = (text: string) => citationsIn('a/b.ts', text).filter((c) => c.kind === 'section')

  // The captured name runs on into the sentence; `namesSection` resolves it by prefix, so the
  // scanner's job here is only to capture the citation with its name at the front.
  const inv = only(sections('`foo.md` § INVARIANTS says so'), 'section citation')
  ok(
    '`§ Name` is a section citation',
    inv.target === 'foo.md' && inv.section.startsWith('INVARIANTS'),
    JSON.stringify(inv.section),
  )

  const quoted = only(
    sections('`foo.md` § "Location parity" is the authority.'),
    'section citation',
  )
  ok(
    'a quoted name ends at its closing quote',
    quoted.section === 'Location parity',
    JSON.stringify(quoted.section),
  )

  const withLine = only(sections('`foo.md` § INVARIANTS (line 7) requires it'), 'section citation')
  ok(
    "cite()'s own `(line N)` suffix is not part of the name",
    withLine.section === 'INVARIANTS',
    JSON.stringify(withLine.section),
  )

  // THE FALSE-ALARM GUARD. `§` is also used as a preposition mid-sentence. Asserting a heading
  // exists for `§ header, "Runtime" line` would invent a claim the author never made.
  ok(
    'a lowercase word after § is prose, not a section name',
    sections('`foo.md` § header, "Runtime" line').length === 0,
  )
  ok('capitalised names are section names', looksLikeSectionName('Measured state'))
  ok('numbered names are section names', looksLikeSectionName('5.3'))
  ok('lowercase names are not', !looksLikeSectionName('header'))

  // SPLIT BY ONE LINE BREAK. A reflowed paragraph puts the file name at the end of one line and the
  // `§` at the start of the next; read line by line, the pointer was never checked at all.
  // `sections(...)` rather than `only(...)` below, so a scanner that stops reading splits reports
  // every case here and the end-to-end cases in § 6, instead of throwing at the first.
  const split = sections('as `CLAUDE.md`\n * § The gate ladder asks of a skip.')
  ok(
    'a pointer split before the § is read, at the line its file name is on',
    split.length === 1 &&
      split[0]?.target === 'CLAUDE.md' &&
      split[0].section.startsWith('The gate ladder') &&
      split[0].at === 1,
    JSON.stringify(split),
  )
  for (const leader of ['', '*', '//', '>', '#', '-']) {
    ok(
      `a split pointer is read after the leader ${JSON.stringify(leader)}`,
      sections(`see \`foo.md\`\n  ${leader} § INVARIANTS says so`).length === 1,
    )
  }
  const afterMark = sections('see `foo.md` §\n// INVARIANTS says so')
  ok(
    'a pointer split between the § and the name is read',
    afterMark.length === 1 && afterMark[0]?.section.startsWith('INVARIANTS') === true,
    JSON.stringify(afterMark),
  )
  ok(
    'a paragraph break ends a pointer',
    sections('see `foo.md`\n\n§ INVARIANTS says so').length === 0,
  )
  ok(
    'two line breaks are never joined',
    sections('see `foo.md`\n§\nINVARIANTS says so').length === 0,
  )
  ok(
    'other text after the break is never joined',
    sections('see `foo.md`\nand § INVARIANTS says so').length === 0,
  )
  const third = sections('# Title\nprose\nsee `foo.md`\n// § Beta')
  ok(
    'a split pointer is reported at its own line, not the first line of the text',
    third.length === 1 && third[0]?.at === 3,
    JSON.stringify(third),
  )

  // NO BACKTICKS ROUND THE FILE NAME. Until 2026-10-03 the pattern required them, so a pointer
  // written `(docs/decisions.md § D-04)` in a shell comment, a JSON string or a refusal message was
  // read by no gate. `sections(...)` rather than `only(...)`, as above, so a
  // scanner that stops reading them reports every case here instead of throwing at the first.
  const plain = sections('decided in (docs/foo.md § INVARIANTS says so)')
  ok(
    'a pointer whose file name is not backticked is read, its path whole',
    plain.length === 1 &&
      plain[0]?.target === 'docs/foo.md' &&
      plain[0].section.startsWith('INVARIANTS'),
    JSON.stringify(plain),
  )
  const spanned = sections('the refusal reads `see docs/foo.md § INVARIANTS` to its reader')
  ok(
    'a pointer inside one code span, its name and section together, is read',
    spanned.length === 1 && spanned[0]?.target === 'docs/foo.md',
    JSON.stringify(spanned),
  )
  ok(
    'a pointer whose file name is not backticked is read when one line break splits it',
    sections('as docs/foo.md\n * § INVARIANTS says so').length === 1,
  )
  ok(
    'a lowercase word after § is prose with or without backticks',
    sections('docs/foo.md § header, "Runtime" line').length === 0,
  )
  // A path that starts outside this checkout is not read from its middle: `foo.md` here names a
  // file under the home directory or the filesystem root, and the backticked form skips both too.
  ok(
    'a home or absolute path is not read from its middle',
    sections('see ~/.claude/foo.md § INVARIANTS and /etc/foo.md § INVARIANTS').length === 0,
  )
  ok(
    'a backticked name keeps its one reading, not a second without the backticks',
    sections('`foo.md` § INVARIANTS says so').length === 1,
  )
  // A POINTER THAT ENDS A STRING LITERAL. The widened read found one in a test that asserts what a
  // refusal says, `includes('docs/decisions.md § D-20')`, and took the closing quote into the name.
  const literal = sections("assert(err.includes('docs/foo.md § D-20'))")
  ok(
    'a name ends at the quote that closes the string around the pointer',
    literal.length === 1 && literal[0]?.section === 'D-20',
    JSON.stringify(literal),
  )
  const apostrophe = only(sections("`foo.md` § Reviewer's rubric says so"), 'section citation')
  ok(
    'an apostrophe inside a name does not end it',
    apostrophe.section.startsWith("Reviewer's rubric"),
    JSON.stringify(apostrophe.section),
  )
  // A NAME'S OWN OPENING QUOTE IS NOT A CLOSING ONE. A quote with no letter after it ends a name only
  // once the name has begun: cut at its opening quote, a quoted name that does not close on its line
  // is empty, and an empty name is no citation at all. Each of these is read as the scanner read it
  // before it read unbackticked names.
  const opened = sections('`foo.md` § "3.2 Three names\nthe next line')
  ok(
    'a quoted name that does not close on its line keeps what follows its opening quote',
    opened.length === 1 && opened[0]?.section === '3.2 Three names',
    JSON.stringify(opened),
  )
  const numbered = sections('`foo.md` § "1) Foo"')
  ok(
    'a quoted number that a bracket ends is read as the number',
    numbered.length === 1 && numbered[0]?.section === '1',
    JSON.stringify(numbered),
  )
  const emphasised = sections('`foo.md` § *"1) Foo"*')
  ok(
    'a wrapper before the opening quote is not the start of the name either',
    emphasised.length === 1 && emphasised[0]?.section === '1',
    JSON.stringify(emphasised),
  )
  // TWO POINTERS ON ONE LINE. An unbackticked name may sit inside the text a pointer before it
  // captured as its section, so reading resumes after the `§`, not after that text.
  const pair = sections('decided in docs/foo.md § Alpha and docs/bar.md § Beta')
  ok(
    'a second unbackticked pointer on the line is read too',
    pair.length === 2 &&
      pair[0]?.target === 'docs/foo.md' &&
      pair[0].section.startsWith('Alpha') &&
      pair[1]?.target === 'docs/bar.md' &&
      pair[1].section === 'Beta',
    JSON.stringify(pair),
  )
  ok(
    'an unbackticked pointer after a backticked one on the line is read too',
    sections('see `docs/foo.md` § Alpha and docs/bar.md § Beta').length === 2,
  )
  // A POINTER'S CONTEXT is every line from its file name to its section name, the name's line
  // included when a break follows the `§`: the match now ends at the `§`, so the context is computed
  // from where the name ends, and computed from the match it would lose that line.
  const context = sections('see `foo.md` §\nINVARIANTS says so')
  ok(
    'a pointer split after the § keeps the name line in its context',
    context.length === 1 && context[0]?.context === 'see `foo.md` § INVARIANTS says so',
    JSON.stringify(context),
  )
}

/* --------------------------------------------------------------------------------------------- *
 * 3. Section resolution -- including the two shapes this repository actually uses
 * --------------------------------------------------------------------------------------------- */

{
  const atx = ['# Title', '', '## 5. Validation', 'body', '### 5.1 The corpus counts', 'more']
  ok('an ATX heading is found by name', namesSection('Validation', atx))
  ok('a numbered section is found by its number', namesSection('5', atx))
  ok('a dotted number is found too', namesSection('5.1', atx))
  ok('a number that is only a prefix of another does not match', !namesSection('51', atx))
  ok(
    'prose running on past the name still resolves',
    namesSection('Validation is the rule here', atx),
  )
  ok('a name in no heading fails', !namesSection('Permissions', atx))

  // NOT ATX-ONLY. The prompt files mark sections with bare uppercase labels and have no `#` at all;
  // a matcher that understood only `#` would report every citation into them as dead.
  const bare = ['A preamble line', '', 'STALE WHEN', 'the threshold is 15%', '', 'CONFIDENCE', 'x']
  ok('a bare uppercase label is a section', namesSection('STALE WHEN', bare))
  ok('the document genuinely has no ATX headings', headingsOf(bare).length === 0)
  ok('a label that is not there still fails', !namesSection('DATABASE CHANGE POLICY', bare))

  // THE PATHOLOGICAL CASE, and the one that actually happened: `verify-layout.md` had zero headings
  // while five places cited a `§S-BASELINE` of it.
  ok(
    'no headings and no matching line is a failure',
    !namesSection('S-BASELINE', ['just prose', 'more prose']),
  )
}

/* --------------------------------------------------------------------------------------------- *
 * 4. Path resolution, in the order the repository writes paths
 * --------------------------------------------------------------------------------------------- */

{
  // SYNTHETIC paths, every one. Nothing here reads the real tree, so the names are chosen not to
  // look like files that exist: an earlier fixture spelled a real file's path, and a reader could
  // mistake the case for a claim about it.
  const tracked = new Set([
    'README.md',
    'docs/README.md',
    'docs/notes/fixture-overview.md',
    'reference/fixture-mirror/skill-tree/SKILL.md',
    '.claude/skills/bead/SKILL.md',
  ])
  const byName = indexByName([...tracked])
  const at = (from: string, target: string) => resolveTarget(from, target, tracked, byName)

  // ROOT FIRST. Reading `README.md` from `docs/` as `docs/README.md` reported a live pointer into
  // the root README as past the end of a 37-line file.
  const r = at('docs/some-plan.md', 'README.md')
  ok('a bare name resolves at the repository root first', 'path' in r && r.path === 'README.md')

  const s = at('docs/plans/Foo.md', 'fixture-overview.md')
  ok(
    'a basename resolves to the nearest file with that name',
    'path' in s && s.path === 'docs/notes/fixture-overview.md',
  )

  const k = at('reference/fixture-mirror/README.md', 'SKILL.md')
  ok(
    "an ambiguous basename resolves to the one in the citing file's own subtree",
    'path' in k && k.path === 'reference/fixture-mirror/skill-tree/SKILL.md',
    'path' in k ? k.path : k.error,
  )

  const repo = at('anywhere.md', `${SCAN_ROOT.split(/[\\/]/).pop() as string}/docs/notes/fixture-overview.md`)
  ok(
    'a path over-qualified with the repository name still resolves',
    'path' in repo && repo.path === 'docs/notes/fixture-overview.md',
  )

  const gone = at('a.md', 'deleted-prompt.md')
  ok('a file that is not tracked is an error', 'error' in gone)

  const tied = at('elsewhere/x.md', 'SKILL.md')
  ok('a basename with no nearer candidate is reported ambiguous', 'error' in tied)
}

/* --------------------------------------------------------------------------------------------- *
 * 5. The exemptions are exemptions, not holes
 * --------------------------------------------------------------------------------------------- */

{
  ok('a path under a HISTORY entry is exempt', historyReason('tools/citations/scan.ts') !== null)
  ok('a live file is not', historyReason('tools/journey/model.ts') === null)

  // A DELIVERED-HANDOFF-PACKAGE EXEMPTION was asserted here on both sides, and was removed with
  // the packages. `tools/citations/scan.ts` keeps the argument for why it existed, because the SHAPE
  // recurs the next time a node copies documents under new paths: committing slice 004's package
  // broke five long-standing citations elsewhere in the tree -- none of them touched -- because ~60
  // copies landed under new paths and made `legacy-visual-spec.md` and `api-surface-report.md`
  // ambiguous basenames.
  //
  // WHAT SURVIVES IT is the property that made the fix possible, and it is not about packages at all:
  // an AMBIGUOUS bare basename must be refused rather than guessed, while a fully-spelled path
  // resolves. That is `resolveTarget`'s own rule and it is what a future exemption would lean on, so
  // it is asserted here directly instead of through a filter with nothing left to filter.
  {
    // Synthetic paths (see § 4): two copies of one basename under directories that need not exist,
    // NEITHER of which shares a leading segment with the citing file -- the nearest-wins rule in
    // `resolveTarget` would otherwise pick the copy under the citer's own directory, and this case
    // is about the tie it refuses to break.
    const tracked = new Set([
      'artifacts/design-system/legacy-visual-spec.md',
      'reference/copies/legacy-visual-spec.md',
    ])
    const byName = indexByName([...tracked])
    const ambiguous = resolveTarget(
      'docs/decisions.md',
      'legacy-visual-spec.md',
      tracked,
      byName,
    )
    ok(
      'a bare basename matching two tracked files is refused, not guessed',
      'error' in ambiguous,
      'error' in ambiguous ? ambiguous.error : ambiguous.path,
    )
    const full = resolveTarget(
      'docs/x.md',
      'reference/copies/legacy-visual-spec.md',
      tracked,
      byName,
    )
    ok(
      'but a fully-spelled path still resolves',
      'path' in full && full.path === 'reference/copies/legacy-visual-spec.md',
      'path' in full ? full.path : full.error,
    )
  }
  ok(
    'every HISTORY entry states a reason',
    HISTORY.every((h) => h.why.trim().length > 20),
  )
  ok(
    'every QUOTED entry states a reason',
    QUOTED.every((q) => q.why.trim().length > 20),
  )

  // A SYNTHETIC REGISTRY, so the match is held whatever `QUOTED` registers today: the live list may
  // legitimately be empty, and a case reading its first entry would then read nothing.
  const registry = [
    { from: 'scripts/fixture.mjs', cites: 'gone-prompt.md:15', why: 'A fixture quotation of a dead pointer, kept as the evidence.' },
  ]
  ok('a registered quotation is exempt in its own file', isQuoted('scripts/fixture.mjs', 'gone-prompt.md:15', registry) !== null)
  ok('the same quotation elsewhere is NOT exempt', isQuoted('some/other/file.ts', 'gone-prompt.md:15', registry) === null)
  ok('a different citation in that file is not exempt', isQuoted('scripts/fixture.mjs', 'unrelated.md:1', registry) === null)
}

/* --------------------------------------------------------------------------------------------- *
 * 6. The gate still has subjects: `check.ts`, end to end, over a synthetic tree
 *
 * Every assertion above holds a function to a fixture, so all of them pass over an empty repository.
 * This is what says the gate is pointed at something: if a regex change silently stopped matching,
 * or the file walk stopped reaching files, the check would go green and only this would notice.
 *
 * THIS SECTION ONCE COUNTED THE REPOSITORY. It asserted floors on this repository's own citations --
 * more than twenty `<file>.md:NN` pointers, more than fifty section pointers, more than a hundred
 * tracked files -- and failed on 2026-09-23 over a repository with no line citation at all, which is
 * a legitimate state. A floor on the repository's content is a gate that fails for a reason no commit
 * repairs. So the gate now runs over a tree built here, through its `CITATIONS_ROOT` override, and the
 * counts are exact because the answer is known by construction.
 *
 * The tree's AGENTS.md is derived from the LIVE `MEMORY_EXEMPT_REGIONS`, one mention inside each
 * registered region, because `check.ts` applies the live registry: a hand-written one would break the
 * control the day the tracker block is registered.
 * --------------------------------------------------------------------------------------------- */

{
  // `runGate` below builds its tree with git under `gitEnv()`, so the tree is only this section's
  // subject if `gitEnv()` leaks no `GIT_*` key; a hook sets one, so set one here and look.
  {
    const saved = process.env['GIT_DIR']
    process.env['GIT_DIR'] = join(tmpdir(), 'not-a-git-dir')
    const leaked = Object.keys(gitEnv()).filter((k) => k.startsWith('GIT_'))
    if (saved === undefined) delete process.env['GIT_DIR']
    else process.env['GIT_DIR'] = saved
    ok('gitEnv() carries no GIT_* key out of a hook', leaked.length === 0, leaked.join(', '))
  }

  const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check.ts')
  const MENTION = '`bd remember` is not used here.'

  const agentsRegions = MEMORY_EXEMPT_REGIONS.filter((r) => r.file === 'AGENTS.md')
  const agents = ['# Fixture', '']
  for (const r of agentsRegions) {
    if ('section' in r) agents.push(`## ${r.section}`, MENTION, '')
    else agents.push(r.between[0], MENTION, r.between[1], '')
  }
  agents.push('## After the regions', 'prose', '')
  const liveSection = agentsRegions.find((r) => 'section' in r)

  // Three line citations (two in a markdown file, one in a source comment); eight section citations
  // (two in a markdown file; two in a source comment, one of them split by a line break; two in a
  // shell script, one of them with its file name not backticked; one in a template; one in a task's
  // description in `tasks.toml`, split by a line break); one dead citation under a `HISTORY`
  // entry, one inside an extension the gate does not scan.
  const TREE: Readonly<Record<string, string>> = {
    'docs/target.md': [
      '# Target',
      '',
      '## Alpha section',
      'the passage a line citation points at',
      '## Beta',
      'the last line',
      '',
    ].join('\n'),
    'docs/citer.md': [
      '# Citer',
      'The rule is at `docs/target.md:4`, and the range `target.md:3-4` holds it too.',
      'Its home is `docs/target.md` § Alpha section, and `target.md` § Beta follows it.',
      '',
    ].join('\n'),
    'tools/code.ts': [
      '// The last word is at docs/target.md:6,',
      '// and `docs/target.md` § Beta has the rest.',
      '// A pointer a line break splits: `docs/target.md`',
      '// § Alpha section, after a comment leader.',
      'export {}',
      '',
    ].join('\n'),
    'scripts/fixture.sh': [
      '#!/bin/sh',
      '# The rule is `docs/target.md` § Alpha section.',
      '# Decided there too (docs/target.md § Beta), its file name not backticked.',
      'exit 0',
      '',
    ].join('\n'),
    'templates/fixture.md.tmpl': ['# {{TITLE}}', 'Read `docs/target.md` § Beta first.', ''].join('\n'),
    'tasks.toml': [
      '["fixture:check"]',
      "description = '''",
      'Refuses what the last line of `docs/target.md`',
      "§ Beta says, wrapped as a description is.'''",
      'run = "node scripts/fixture.mjs"',
      '',
    ].join('\n'),
    'tools/citations/fixture-history.ts': [
      '// It once cited docs/target.md:999, which this record keeps as written.',
      'export {}',
      '',
    ].join('\n'),
    'notes.txt': 'docs/target.md:999 is not read here: .txt is not a scanned extension.\n',
    'AGENTS.md': agents.join('\n'),
    '.claude/skills/fixture/SKILL.md': ['# Fixture skill', 'Run `bd ready`, then `bd show <id>`.', ''].join('\n'),
  }

  interface Run {
    status: number | null
    out: string
    err: string
  }
  const runGate = (tree: Readonly<Record<string, string>>): Run => {
    const dir = mkdtempSync(join(tmpdir(), 'citations-selftest-'))
    try {
      for (const [path, text] of Object.entries(tree)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
      // Without any GIT_* key: an inherited GIT_DIR, which the hook runner drops but another caller
      // may not, outranks `cwd`, and the gate would list THIS repository's files while claiming to
      // read the tree.
      const env = gitEnv()
      execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'ignore' })
      execFileSync('git', ['add', '-A'], { cwd: dir, env, stdio: 'ignore' })
      const r = spawnSync(process.execPath, [CHECK], {
        cwd: dir,
        env: { ...env, CITATIONS_ROOT: dir },
        encoding: 'utf8',
      })
      return { status: r.status, out: r.stdout, err: r.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

  const SUMMARY =
    /(\d+) line citations and (\d+) section citations across (\d+) files \((\d+) files and (\d+) citations exempt as history\); memory rule over (\d+) prompt files \((\d+) mentions exempt/
  const control = runGate(TREE)
  const m = SUMMARY.exec(control.out)
  ok(
    'control: the undoctored tree passes the gate',
    control.status === 0 && m !== null,
    `exit ${control.status}; ${firstLine(control.err) || firstLine(control.out)}`,
  )
  const n = (i: number): number => Number(m?.[i] ?? Number.NaN)
  ok('the scan finds line citations to resolve -- exactly the three the tree holds', n(1) === 3, `${n(1)} found`)
  ok('the scan finds section citations to resolve -- exactly the eight the tree holds', n(2) === 8, `${n(2)} found`)
  ok(
    'the gate reads the tracked text files, eight with the script, the template and the task file, and skips the extension it does not scan',
    n(3) === 8,
    `${n(3)} files`,
  )
  ok('the dead citation under a HISTORY entry is exempt, and counted', n(4) === 1, `${n(4)} files`)
  ok('the roster has prompt files to scan -- exactly the two the tree holds', n(6) === 2, `${n(6)} files`)
  ok(
    'a mention inside each registered AGENTS.md region is exempted rather than absent',
    n(7) === agentsRegions.length && n(7) > 0,
    `${n(7)} exempt of ${agentsRegions.length} regions`,
  )

  // ONE BREAK PER COPY, and each must fail for the reason it was doctored for and for no other: the
  // problem count is asserted too, so a copy failing for an unrelated reason cannot pass as a bite.
  const edit =
    (file: string, from: string, to: string) =>
    (tree: Record<string, string>): void => {
      const text = tree[file]
      if (text === undefined || !text.includes(from)) {
        throw new Error(`fixture: ${file} has no ${JSON.stringify(from)} to doctor`)
      }
      tree[file] = text.replace(from, to)
    }
  const cases: ReadonlyArray<{
    what: string
    doctor: (tree: Record<string, string>) => void
    where: string
    reason: string
    problems: number
  }> = [
    {
      what: 'a line citation past the end of its file',
      doctor: edit('docs/citer.md', '`docs/target.md:4`', '`docs/target.md:40`'),
      where: 'docs/citer.md:2',
      reason: 'The pointer is past the end of the file.',
      problems: 1,
    },
    {
      what: 'a line citation onto a blank line',
      doctor: edit('docs/citer.md', '`docs/target.md:4`', '`docs/target.md:2`'),
      where: 'docs/citer.md:2',
      reason: 'which is a BLANK line of docs/target.md',
      problems: 1,
    },
    {
      what: 'a citation to a file that is not tracked',
      doctor: edit('tools/code.ts', 'docs/target.md:6', 'docs/gone.md:6'),
      where: 'tools/code.ts:1',
      reason: 'names "docs/gone.md", which is not a tracked file',
      problems: 1,
    },
    {
      what: 'a section citation to a heading that is not there',
      doctor: edit('docs/citer.md', '§ Beta', '§ Gamma'),
      where: 'docs/citer.md:3',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: 'a section citation split by a line break, to a heading that is not there',
      doctor: edit('tools/code.ts', '// § Alpha section, after', '// § Gamma, after'),
      where: 'tools/code.ts:3',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: 'a section citation in a shell script, to a heading that is not there',
      doctor: edit('scripts/fixture.sh', '§ Alpha section', '§ Gamma'),
      where: 'scripts/fixture.sh:2',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: 'a section citation whose file name is not backticked, to a heading that is not there',
      doctor: edit('scripts/fixture.sh', '(docs/target.md § Beta)', '(docs/target.md § Gamma)'),
      where: 'scripts/fixture.sh:3',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: 'a section citation in a template, to a heading that is not there',
      doctor: edit('templates/fixture.md.tmpl', '§ Beta', '§ Gamma'),
      where: 'templates/fixture.md.tmpl:2',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: "a section citation in a task's description, split by a line break, to a heading that is not there",
      doctor: edit('tasks.toml', '§ Beta says', '§ Gamma says'),
      where: 'tasks.toml:3',
      reason: 'but no section of docs/target.md is named that',
      problems: 1,
    },
    {
      what: 'the same dead citation, moved out from under its HISTORY entry',
      doctor: (tree) => {
        tree['tools/fixture-history.ts'] = tree['tools/citations/fixture-history.ts'] ?? ''
        delete tree['tools/citations/fixture-history.ts']
      },
      where: 'tools/fixture-history.ts:1',
      reason: 'The pointer is past the end of the file.',
      problems: 1,
    },
    {
      what: 'a prompt citing a memory key',
      doctor: edit('.claude/skills/fixture/SKILL.md', 'Run `bd ready`', 'See memory `fixture-key`, then run `bd ready`'),
      where: '.claude/skills/fixture/SKILL.md:2',
      reason: 'cites memory `fixture-key`',
      problems: 1,
    },
    {
      // The renamed heading is one problem and the mention it covered goes live: two.
      what: 'the registered AGENTS.md section renamed, so its exemption matches nothing',
      doctor:
        liveSection && 'section' in liveSection
          ? edit('AGENTS.md', `## ${liveSection.section}`, '## A heading the registry does not name')
          : () => {
              throw new Error('fixture: the live registry has no AGENTS.md section region to rename')
            },
      where: 'AGENTS.md',
      reason: 'but no such region is in the file',
      problems: 2,
    },
  ]
  for (const c of cases) {
    const tree = { ...TREE }
    c.doctor(tree)
    const r = runGate(tree)
    const count = Number(/(\d+) unresolvable citation/.exec(r.err)?.[1] ?? Number.NaN)
    ok(
      `${c.what} -- fails for that reason`,
      r.status === 1 && r.err.includes(c.where) && r.err.includes(c.reason) && count === c.problems,
      `exit ${r.status}; ${count} problem(s); ${firstLine(r.err.split('\n').slice(2).join('\n'))}`,
    )
  }
}

/* --------------------------------------------------------------------------------------------- *
 * 7. The memory rule: a citation whose target cannot exist
 *
 * `tools/citations/memory.ts` carries the argument. Every assertion here goes through
 * `memoryProblemsIn`, the one function `check.ts` calls, so a fixture that fails here fails the
 * gate and one that passes here passes it. The DERIVATION is asserted, never a count of the live
 * tree: how many mentions AGENTS.md's registered regions exempt today is whatever `citations:check`
 * prints, and written here it would drift like every other numeral.
 * --------------------------------------------------------------------------------------------- */

{
  const prompt = '.claude/skills/fixture/SKILL.md'
  const problemsIn = (file: string, text: string) => memoryProblemsIn(file, text).problems

  // The spelling a prompt review recorded for every key it named, and the three tokens.
  const key = only(
    problemsIn(prompt, 'see memory `register-no-foreign-short-shas` for the remedy'),
    'problem',
  )
  ok(
    '`memory `key`` in a prompt is a finding at its line',
    key.where === `${prompt}:1` && key.what.includes('register-no-foreign-short-shas'),
    `${key.where} -- ${key.what}`,
  )
  ok(
    'the word is matched case-insensitively',
    problemsIn(prompt, 'Memory `x-y` says so').length === 1,
  )
  const wrapped = only(
    problemsIn(prompt, 'the direction gotcha (memory\n  `bd-deps-blocks-direction`).'),
    'problem',
  )
  ok(
    'the line-wrapped spelling is one finding, reported at the line the word is on',
    wrapped.where === `${prompt}:1` && wrapped.context.includes('`bd-deps-blocks-direction`'),
    `${wrapped.where} -- ${wrapped.context}`,
  )
  ok(
    'a paragraph break between the word and the span is prose',
    problemsIn(prompt, 'stays in memory\n\n`bd dolt push` closes the bracket').length === 0,
  )
  for (const token of ['bd recall', 'bd remember', 'bd memories']) {
    ok(
      `\`${token}\` is a finding, backticked`,
      problemsIn(prompt, `run \`${token} <key>\` first`).length === 1,
    )
    ok(`\`${token}\` is a finding, bare`, problemsIn(prompt, `then ${token} it`).length === 1)
  }
  ok(
    'two shapes on one line are two findings',
    problemsIn(prompt, 'memory `k` via `bd recall k`').length === 2,
  )
  ok(
    'a negation does not exempt a line by itself',
    problemsIn(prompt, 'never in `bd remember` and never in a memory file').length === 1,
  )

  // THE FALSE-ALARM GUARD: a gate that cries wolf is deleted and then checks nothing.
  ok(
    'the auto-memory directory path is not a key',
    problemsIn(prompt, 'the per-project `memory/` directory the harness keeps').length === 0,
  )
  ok(
    'a hyphenated compound before a code span is not a key',
    problemsIn(prompt, 'rebuilt in-memory `index.json` and byte-compared').length === 0,
  )
  ok(
    '`memory` followed by prose is not a key',
    problemsIn(prompt, 'measured timings stay in memory. The skill is a checklist').length === 0,
  )
  ok(
    '`bd` commands that are not the store are untouched',
    problemsIn(prompt, 'run `bd ready`, `bd show <id>` and `bd dolt push`').length === 0,
  )
  ok(
    '`memories` without `bd` is prose',
    problemsIn(prompt, 'loads the issue tracker context and stored project memories').length === 0,
  )

  // SCOPE: the roster, and nothing outside it.
  for (const f of [
    '.claude/agents/fixture.md',
    '.claude/settings.json',
    '.codex/agents/fixture.toml',
    '.codex/config.toml',
    '.agents/skills/fixture/SKILL.md',
    '.github/skills/fixture/SKILL.md',
    '.github/agents/fixture.agent.md',
    '.opencode/skills/fixture/SKILL.md',
    '.opencode/agents/fixture.md',
    '.harness/skills/fixture/SKILL.md',
    '.beads/formulas/fixture.formula.toml',
    '.beads/PRIME.md',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
  ]) {
    ok(`${f} is in scope`, inMemoryScope(f))
  }
  ok(
    'the text `bd prime` prints at every session start is a prompt, and naming the store there is a finding',
    memoryProblemsIn('.beads/PRIME.md', 'Use `bd remember "insight"` for persistent knowledge').problems
      .length === 1,
  )
  const outside = memoryProblemsIn('tools/citations/memory.ts', 'bd recall')
  ok(
    'a file outside the roster is skipped with the reason, not scanned',
    outside.skipped !== null && outside.problems.length === 0,
    outside.skipped ?? 'scanned',
  )
  ok('`docs/` is outside the roster', !inMemoryScope('docs/decisions.md'))
  ok(
    'every exempt region states a reason and names AGENTS.md',
    MEMORY_EXEMPT_REGIONS.every((r) => r.why.trim().length > 20 && r.file === 'AGENTS.md'),
  )

  // A SYNTHETIC REGISTRY, one region of each shape. These cases once ran against the live
  // `MEMORY_EXEMPT_REGIONS` and asserted an exempt generated block, which the live registry does not
  // hold, since no block is written into CLAUDE.md (`memory.ts` says why); on 2026-09-23 they
  // found 3 exempt where they expected 4, and 2 problems where they expected 1. The gate was right and
  // the fixture was not. Held to its own registry, the fixture exercises both shapes whatever the
  // live one holds; the live registry is held to the live AGENTS.md at the end of this section.
  const REGIONS: ReadonlyArray<ExemptRegion> = [
    {
      file: 'CLAUDE.md',
      section: 'Rules for agents live in tracked files, and nowhere else',
      why: 'The fixture forbidding section, keyed on its heading text.',
    },
    {
      file: 'CLAUDE.md',
      between: ['<!-- BEGIN BEADS INTEGRATION', '<!-- END BEADS INTEGRATION -->'],
      why: 'The fixture generated block, keyed on the markers around it.',
    },
  ]

  // THE TWO CLAUDE.md REGIONS, on a fixture shaped like the file: the forbidding section runs from
  // its heading to the next heading; the generated block runs between bd's markers; a mention after
  // both is live. Four mentions inside, one outside.
  const claude = [
    '## Some earlier section',
    'prose',
    '## Rules for agents live in tracked files, and nowhere else',
    '- **`bd remember` is not used.** `bd memories` prints an empty list.',
    '  do not tell a reader to `bd recall` one.',
    '<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:deadbeef -->',
    '## Beads Issue Tracker',
    '- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files',
    '<!-- END BEADS INTEGRATION -->',
    '## After the block',
    'see memory `late-key` here',
  ]
  const shaped = memoryProblemsIn('CLAUDE.md', claude.join('\n'), REGIONS)
  ok(
    'mentions inside the forbidding section and the generated block are exempt',
    shaped.exempted === 4,
    `${shaped.exempted} exempt`,
  )
  const late = only(shaped.problems, 'problem')
  ok('a mention after both regions is a finding', late.where === 'CLAUDE.md:11', late.where)

  // The exemption is keyed on the FILE as well as the delimiter: the heading cannot be copied.
  const copied = memoryProblemsIn(prompt, claude.join('\n'), REGIONS).problems.length
  ok('the same heading and markers in a skill exempt nothing', copied === 5, `${copied} problems`)

  // A registered region that is not in the file is a FINDING, not a silent pass: the renamed
  // heading is reported, the absent markers are reported, and the mention the section covered goes
  // live -- three problems from one line of prose.
  const renamed = memoryProblemsIn(
    'CLAUDE.md',
    ['## Rules for agents live somewhere else', '`bd remember` is not used.'].join('\n'),
    REGIONS,
  )
  ok(
    'a renamed heading is reported as a missing region and its mention goes live',
    renamed.problems.length === 3 &&
      renamed.problems.filter((p) => p.what.includes('no such region')).length === 2,
    renamed.problems.map((p) => p.where).join(', '),
  )

  // THE LIVE TREE. Every registered region is present in AGENTS.md -- an exemption matching
  // nothing is a hole -- and the roster is clean. No count of the live tree is asserted: this read
  // "with its mentions exempted rather than absent" until 2026-09-23, when the live CLAUDE.md named
  // the store without the forbidden spelling and so had none to exempt, which is a legitimate state.
  // That the registered regions exempt what they cover is asserted on the synthetic tree in § 6.
  const liveAgents = readFileSync(join(SCAN_ROOT, 'AGENTS.md'), 'utf8')
  const regions = exemptRegionsIn('AGENTS.md', liveAgents.split('\n'))
  ok(
    'every registered region is found in the live AGENTS.md',
    regions.missing.length === 0 && regions.found.length === MEMORY_EXEMPT_REGIONS.length,
    regions.missing.map(describeRegion).join('; '),
  )
  const live = memoryProblemsIn('AGENTS.md', liveAgents)
  ok(
    'the live AGENTS.md passes the memory rule',
    live.problems.length === 0,
    live.problems.map((p) => p.where).join(', '),
  )
  const liveProblems: string[] = []
  for (const f of trackedFiles()) {
    if (!inMemoryScope(f)) continue
    let text: string
    try {
      text = readFileSync(join(SCAN_ROOT, f), 'utf8')
    } catch {
      continue
    }
    liveProblems.push(...memoryProblemsIn(f, text).problems.map((p) => p.where))
  }
  ok(
    'no tracked prompt cites a memory key or names the store',
    liveProblems.length === 0,
    liveProblems.join(', '),
  )
}

console.log(
  failures ? `\n${failures} of ${checks} assertions FAILED` : `\n${checks} assertions pass`,
)
process.exit(failures ? 1 : 0)

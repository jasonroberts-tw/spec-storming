/**
 * Cross-document citations, resolved against the documents they name.
 *
 * WHAT THIS IS FOR. A citation written as `some-file.md:96` is a fact about another file that
 * nothing recomputes when that file changes. It rots silently and in the worst possible direction:
 * the pointer still LOOKS authoritative, so a reader who follows it and lands on unrelated prose
 * concludes they have misunderstood, not that the citation is wrong. The same is true of a citation
 * to a SECTION that does not exist.
 *
 * Both have bitten repeatedly, which is why this exists rather than a convention:
 *
 *   - `verify-layout.md:96`, cited by `tools/formhost/types.ts` and `tools/FormHostCapture/README.md`
 *     as the source of the capture-conditions set, resolved to a Playwright line. The text was at
 *     `:144`. `verify-layout.md:203`, cited by `claude-code-prompts.md`, resolved to a BLANK line;
 *     the text was at `:76`.
 *   - That same file had ZERO markdown headings while FIVE places cited a `§S-BASELINE` section of
 *     it. The anchor had never existed at any point in the file's life.
 *   - Roughly twenty `model.md:NN` citations into one document drifted twice; by the time a tracked issue was
 *     worked, 17 of the 18 distinct ones resolved to unrelated prose -- a horizontal rule, a blank
 *     line, the header row of the wrong table.
 *
 * THIS IS THE FLOOR, NOT THE CEILING. The strong form would be a citation as a registered key whose
 * value is a distinctive PHRASE, so that the line is recomputed on every run and the passage is
 * checked by content. No such registry is tracked here (none was on 2026-09-30), and it would only
 * cover the citations that adopted it, where a repository holds many that have not. This takes citations exactly as they are WRITTEN, anywhere in the
 * repository, and asserts the cheap thing: that a reader following the pointer arrives somewhere real.
 *
 * What it leaves is whether that somewhere SAYS what the citing sentence claims. The two are
 * complements, and the division is deliberate:
 *
 *   - resolution -> here, a gate: catches the pointer that now lands on nothing, on a line past the
 *     end of the file, or on a blank
 *   - support -> a judgment over the citing lines and the cited section, which needs a reader rather
 *     than a rule and so can never be part of this gate
 *
 * WHY IT SCANS EVERYTHING BY DEFAULT. The phrase registry's selftest in the repository this gate was
 * copied from (not tracked here) scanned an allowlist of two directories, and the history of that
 * decision is the argument against copying it: its first
 * version covered ONE document, which left every citation into a sibling prompt exactly as exposed
 * as before -- and three had already drifted, one of them into a SHIPPED artifact, because no gate
 * could see them. An allowlist does not grow when the repository does. This scans every tracked text
 * file and takes exemptions one at a time, so a new citation is covered the day it is written and
 * every exemption is a line in a diff with a reason attached.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK.
 *
 *   - QUOTATIONS. A retest log quotes stale citations on purpose. A gate that fails on the record of
 *     a past defect is a gate nobody can make green, so it gets deleted and checks nothing. See
 *     `HISTORY` and `QUOTED`.
 *   - WHETHER THE CITED LINE SAYS WHAT THE CITER CLAIMS. That needs a judgment over two texts, not a
 *     rule, so it is left to a reader. Resolution is the half that can be checked deterministically,
 *     which is why it is the gate.
 *   - NUMERALS restated from another document. A prompt that repeats a corpus count it did not
 *     derive is a real and more expensive defect, but it needs a policy about prompt-embedded
 *     numerals rather than a scanner.
 *   - BARE FILENAME MENTIONS -- a backticked `X.md` carrying no `:NN` and no `§`. `LINE_RE` and
 *     `SECTION_RE` below both require a locator, so a bare name is outside the definition of a
 *     citation used here. **That was measured and refused, not overlooked.** A survey walked every
 *     one of them. A blanket rule produces 327 findings, of which the large
 *     majority are correct writing: shorthand for a path the document states once, and deliberate
 *     mentions of deleted files (where the mention IS the record).
 *     **Do not add that rule here.** The residue is real but semantic -- a bare name is a defect
 *     only when the passage presents the file as extant -- so it stays a review habit, with one
 *     mechanical shape worth fixing on sight: a source attribution, "per `X.md`",
 *     with no locator.
 *
 * Reads only this repository, needs no `../sibling` checkout and no network.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from '../lib/paths.ts'

/**
 * The checkout this gate reads: the repository, or the doctored copy `CITATIONS_ROOT` names. The
 * selftest points the gate at a synthetic tree under the temporary directory through it, and a
 * by-hand run can do the same without editing anything (`AGENTS.md` § Standing rules for prompts
 * and gates). Every path below is relative to it.
 */
export const SCAN_ROOT = process.env.CITATIONS_ROOT ? resolve(process.env.CITATIONS_ROOT) : ROOT

/**
 * Text files worth scanning. Anything else is either binary or has no citations in it.
 *
 * `tmpl` and `sh` were added on 2026-09-26. Until then the worktree briefing's template cited a
 * decision-register entry, and a shell script's comment could cite any
 * section, with no gate reading either. Measured before they were added: the three tracked files of
 * those types held one pointer in the form this gate reads, and it resolved.
 *
 * `toml` was added on 2026-10-04, when each task's description moved from the README's table of
 * tasks, which this gate reads, into `tasks.toml`, which it did not: the move would
 * have left the three section pointers those descriptions carry unread. Until then `mise.toml`'s
 * comments and `tasks.toml`'s header went unread too. Measured before it was added, through
 * `citationsIn`: the three tracked files of that type held 14 pointers in the forms this gate reads,
 * 9 in `mise.toml`, 5 in `tasks.toml` and none in the uv lock's `pyproject.toml`, and all 14 resolved.
 * It reads a `.toml` file as written, not as TOML: a pointer in a comment or a `'''` string is read,
 * and one spelled through a basic string's escapes (a `\u` escape for the section sign, `\n`, a
 * line-ending backslash) is not, though mise prints it as a pointer. `tasks.toml` writes every
 * description as `'''` for that reason, as the `add-task` skill's step 5 asks; nothing refuses
 * another form.
 */
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|md|json|ya?ml|cs|sql|tmpl|sh|toml)$/

/**
 * Files whose `<file>.md:NN` and `§<Name>` occurrences are HISTORY, not live pointers.
 *
 * Every entry is a path or a path prefix, and every entry states why. The bar is that the document's
 * PURPOSE is to record what something said at a moment in time -- not merely that it happens to
 * contain a stale citation, which is the thing this gate exists to make someone fix.
 *
 * Keep this short. An entry here is a hole in the gate, and the failure mode of a generous exemption
 * list is a green check over a repository nobody is actually checking.
 */
export const HISTORY: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'tools/citations/',
    why: 'This gate and its selftest. Both quote the citations they exist to catch.',
  },
  // ADD YOUR OWN ENTRIES HERE, one at a time, each with its reason: a retest log that quotes the
  // defective citations it records, the working behind a decision whose subject was deleted, an
  // inbound record whose citations are a correspondent's. REMOVE an entry with its subject: an
  // entry matching nothing is a hole dressed as an exemption.
]

/**
 * Single citations, inside otherwise-live files, that are QUOTATIONS of a dead pointer.
 *
 * The whole-file exemptions above are for documents whose PURPOSE is to record the past. This is for
 * the other shape: a live document that quotes one dead citation as the evidence for a decision.
 * Repointing it would erase the finding, and exempting the whole file would take its live
 * citations out of the gate along with it. Remove an entry with its citation: an entry matching
 * nothing is the hole dressed as an exemption the comments above describe.
 *
 * KEYED BY THE CITATION TEXT, NEVER BY LINE NUMBER. An allowlist of `file.md:112` entries would be a
 * list of line numbers that nothing recomputes, which is the exact disease this gate treats; the
 * suppressions would slide off their citations the first time someone edited above them and start
 * silently exempting whatever moved into their place. The pair (citing file, citation as written) is
 * stable under every edit that does not change the citation itself.
 */
export const QUOTED: ReadonlyArray<{ from: string; cites: string; why: string }> = [
  // ADD YOUR OWN ENTRIES HERE, keyed by (citing file, citation as written) and never by line
  // number: a register entry quoting a file a later decision deleted, a frozen record citing a
  // regenerated artifact by line, a prompt naming a file its own node has not emitted yet. A
  // register entry is amended by a dated note and never rewritten, so its citation stays literal.
]

/**
 * Whether this citation, in this file, is a registered quotation.
 *
 * By PREFIX on the citation text, because a section name written inline runs on into the sentence
 * around it -- `` `fidelity-findings.md` §4 both claimed the client-area diff... `` is one citation
 * whose captured name is the whole rest of the clause. Requiring an exact match would mean writing
 * that clause into the registry and re-writing it whenever the prose was edited, which is a line
 * number by another name.
 *
 * `quoted` is the registry, and the gate always passes the live one by default. The selftest passes a
 * synthetic one, so the match stays exercised whatever this repository has registered today.
 */
export function isQuoted(
  from: string,
  cites: string,
  quoted: ReadonlyArray<{ from: string; cites: string; why: string }> = QUOTED,
): string | null {
  for (const q of quoted) if (q.from === from && cites.startsWith(q.cites)) return q.why
  return null
}

/** A `<file>.md:NN` or `<file>.md:NN-MM` pointer, as written. */
export interface LineCitation {
  kind: 'line'
  /** Repository-relative path of the file the citation is written in. */
  from: string
  /** 1-based line of `from` the citation sits on. */
  at: number
  /** The path as written, e.g. `journey-plane.md` or `specs/screens/Foo.md`. */
  target: string
  first: number
  last: number
  /** The whole source line, for the failure message. */
  context: string
}

/** A `<file>.md § <Name>` pointer, its file name backticked or not, as written. */
export interface SectionCitation {
  kind: 'section'
  from: string
  /** 1-based line of `from` the cited file's name sits on, where a line break splits the pointer. */
  at: number
  target: string
  /** The section name as written, with quotes/emphasis stripped. */
  section: string
  context: string
}

export type Citation = LineCitation | SectionCitation

/**
 * `foo.md:12`, `docs/foo.md:12-18`.
 *
 * The path may not start with `-` or `/`, so a range's second half (`:583` in `md:561, :583`) is not
 * mistaken for a new citation. Continuation spellings like that are NOT matched, and that is a known
 * floor rather than an oversight: catching them needs the parser this file's header declines to be.
 */
const LINE_RE = /([A-Za-z0-9._][A-Za-z0-9._/-]*\.md):(\d+)(?:-(\d+))?/g

const GAP = String.raw`[^\S\n]*`
const BREAK = String.raw`[^\S\n]*\n[^\S\n]*(?:\/\/|[*>#-])?[^\S\n]*`
const NAME = String.raw`[A-Za-z0-9._][A-Za-z0-9._/-]*\.md`
// Group 1 is a backticked name, group 2 an unbackticked one, group 3 the section, in a lookahead,
// so the whole match ends before the section.
const SECTION_RE = new RegExp(
  String.raw`(?:\`(${NAME})\`|(?<![A-Za-z0-9._/-])(${NAME}))` +
    `(?:${BREAK}§${GAP}|${GAP}§(?:${BREAK}|${GAP}))` +
    String.raw`(?=([^\`\n,;)|]{2,80}))`,
  'g',
)

/** Every git-tracked path, repository-relative. */
export function trackedFiles(): string[] {
  return gitFiles([])
}

/**
 * Whether the gate also reads the files git lists as untracked and not ignored. Off unless
 * `CITATIONS_UNTRACKED=1`, so off at pre-push and in CI, where a file nobody has added is not part
 * of what is pushed. A Stop hook can turn it on: in a session the newest file is the likeliest to
 * carry a bad pointer, and until it is staged a gate over tracked files never reads it. On 2026-09-24
 * such a hook printed PASS at every one of a change's 33 stops while the change's unstaged design
 * sat unread.
 */
export const INCLUDE_UNTRACKED = process.env.CITATIONS_UNTRACKED === '1'

/** Every untracked path git does not ignore, repository-relative. */
export function untrackedFiles(): string[] {
  return gitFiles(['--others', '--exclude-standard'])
}

function gitFiles(flags: readonly string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...flags], {
    cwd: SCAN_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean)
}

/** Whether `file` is exempt, and the reason if so. */
export function historyReason(file: string): string | null {
  for (const h of HISTORY) {
    if (file === h.path || file.startsWith(h.path)) return h.why
  }
  return null
}

/**
 * The file a citation names, repository-relative, or a reason it cannot be resolved.
 *
 * Three strategies, in order. Most citations are written relative to the repository root, but plenty
 * are written relative to the citing file's own directory, and a third group names only a BASENAME
 * (`SKILL.md:78` from inside a mirror's README, describing a mirrored tree one directory down; the
 * selftest keeps the case on synthetic paths). The basename strategy demands a UNIQUE match: two
 * files with the same name make the citation genuinely ambiguous, and guessing which was meant is how a checker starts asserting the
 * wrong thing confidently.
 */
export function resolveTarget(
  from: string,
  target: string,
  tracked: ReadonlySet<string>,
  byName: ReadonlyMap<string, string[]>,
): { path: string } | { error: string } {
  // REPOSITORY-ROOT FIRST, because that is this repository's convention -- AGENTS.md writes every
  // path from the root, and so does almost every citation. Trying the citing file's own directory
  // first read `README.md:368` in `docs/some-plan.md` as `docs/README.md`, which is 37
  // lines long, and reported a live pointer into the 440-line root README as past the end of a file.
  const atRoot = normalise(stripRepoPrefix(target))
  if (tracked.has(atRoot)) return { path: atRoot }
  const beside = normalise(join(dirname(from), target))
  if (tracked.has(beside)) return { path: beside }

  const suffix = byName.get(target.split('/').pop() as string) ?? []
  const ending = suffix.filter((p) => p === target || p.endsWith(`/${target}`))
  if (ending.length === 1) return { path: ending[0] as string }
  if (ending.length > 1) {
    // NEAREST WINS. `SKILL.md` was the name of five tracked files when this was written, four of
    // them Claude Code skills; cited from inside a skill mirror's README it unambiguously meant the
    // one in the mirrored tree beside it. Preferring the deepest shared
    // prefix with the citing file is how a human reads a bare filename, and without it every common
    // basename is reported ambiguous forever.
    const nearest = ending
      .map((p) => ({ p, shared: sharedPrefixLength(from, p) }))
      .sort((a, b) => b.shared - a.shared)
    const best = nearest[0] as { p: string; shared: number }
    const tied = nearest.filter((n) => n.shared === best.shared)
    if (tied.length === 1 && best.shared > 0) return { path: best.p }
    return {
      error:
        `names "${target}", which matches ${ending.length} tracked files (${ending.join(', ')}) and` +
        ' none of them is nearer to this file than the others. Write enough of the path to pick' +
        ' one -- an ambiguous citation cannot be followed.',
    }
  }
  return {
    error:
      `names "${target}", which is not a tracked file. It was moved, retired or never existed,` +
      ' and a reader following this pointer arrives nowhere.',
  }
}

const normalise = (p: string): string =>
  resolve(SCAN_ROOT, p)
    .slice(SCAN_ROOT.length + 1)
    .split('\\')
    .join('/')

/**
 * `<this-checkout>/docs/foo.md` -> `docs/foo.md`: the prefix is the name of the checkout's
 * own directory, read from `SCAN_ROOT` rather than written here.
 *
 * A handful of citations name the repository directory as well as the path inside it, usually
 * written by someone working across both checkouts at once. It resolves to the same file either way,
 * and reporting it as a dead reference would be false.
 */
const REPO_PREFIX = `${SCAN_ROOT.split(/[\\/]/).pop() as string}/`
const stripRepoPrefix = (p: string): string =>
  p.startsWith(REPO_PREFIX) ? p.slice(REPO_PREFIX.length) : p

/** How many leading path SEGMENTS two repository-relative paths share. */
function sharedPrefixLength(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

/**
 * AN `isDeliveredPackage(file)` PREDICATE STOOD HERE, matching a delivered package's directory,
 * and was deleted with the packages. The argument is kept because the SHAPE will recur the next
 * time this repository copies documents under new paths.
 *
 * It excluded a delivered handoff package from this gate on BOTH sides, for two different reasons.
 * AS A CITING FILE: most of a package's `.md` files were byte-identical copies of documents living
 * elsewhere, so their citations were already checked at the source, and the prompt forbade editing a
 * path inside a copy -- a gate whose only available fix is forbidden is a gate nobody can make green.
 * AS A CITATION TARGET, which is the half that actually broke: `resolveTarget` falls back to a bare
 * BASENAME and demands a unique match, so the moment slice 004's ~60-file package was committed,
 * `legacy-visual-spec.md` and `api-surface-report.md` each matched two tracked files and five
 * long-standing citations elsewhere became ambiguous -- none of them touched.
 *
 * IF A FUTURE NODE COPIES DOCUMENTS UNDER NEW PATHS, that second failure returns on the day the copy
 * lands, and the fix is this predicate again: filter the BASENAME INDEX and never `trackedSet`, so a
 * citation spelling the copy's path out in full still resolves while a bare basename cannot silently
 * reach it.
 */

/** Index of basename -> every tracked path with that basename. */
export function indexByName(tracked: readonly string[]): Map<string, string[]> {
  const byName = new Map<string, string[]>()
  for (const p of tracked) {
    const base = p.split('/').pop() as string
    const bucket = byName.get(base)
    if (bucket) bucket.push(p)
    else byName.set(base, [p])
  }
  return byName
}

/**
 * Every citation written in `text`, which is the content of `from`, in the order of the lines they
 * start on.
 *
 * Line citations are read line by line. Section citations are read over the whole text, because
 * one may cross a line break (`SECTION_RE`); each is reported at the line its file name is on, with
 * every line it spans as its context.
 */
export function citationsIn(from: string, text: string): Citation[] {
  const out: Citation[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LINE_RE)) {
      const first = Number(m[2])
      out.push({
        kind: 'line',
        from,
        at: i + 1,
        target: m[1] as string,
        first,
        last: m[3] ? Number(m[3]) : first,
        context: line.trim(),
      })
    }
  })
  const lineOf = lineIndexer(text)
  for (const m of text.matchAll(SECTION_RE)) {
    const named = m[3] as string
    const section = stripWrapper(named.trim())
    if (section && looksLikeSectionName(section)) {
      const first = lineOf(m.index)
      // The match ends at the `§` and the gap after it, since the name is read by a lookahead
      // (`SECTION_RE`), so the pointer's last line is the one its name ends on, past `m[0]`. A
      // break after the `§` puts that line after the last line `m[0]` touches.
      const last = lineOf(m.index + m[0].length + named.length - 1)
      out.push({
        kind: 'section',
        from,
        at: first + 1,
        target: (m[1] ?? m[2]) as string,
        section,
        context: lines
          .slice(first, last + 1)
          .map((l) => l.trim())
          .join(' '),
      })
    }
  }
  // Stable, so a line citation stays ahead of a section citation on the same line, as it was when
  // both were read in one pass per line.
  return out.sort((a, b) => a.at - b.at)
}

/**
 * The 0-based line of an offset into `text`, for offsets asked in ascending order or on the line of
 * the last one asked. `citationsIn` asks a smaller offset only for a pointer that starts inside the
 * name the pointer before it ends on, and a name holds no line break, so the two share that line.
 */
function lineIndexer(text: string): (offset: number) => number {
  let line = 0
  let next = text.indexOf('\n')
  return (offset) => {
    while (next !== -1 && next < offset) {
      line++
      next = text.indexOf('\n', next + 1)
    }
    return line
  }
}

/**
 * `"Measured state"` -> `Measured state`; `*S-BASELINE*` -> `S-BASELINE`.
 *
 * The trailing `(line 32)` is stripped because that is `cite()`'s OWN render format -- it appends a
 * recomputed line number to a section reference. Reading it back as part of the section name would
 * make this gate fail on the output of the mechanism it is the floor under, which is the one result
 * that would be actively worse than not checking.
 */
function stripWrapper(s: string): string {
  // A QUOTED name ENDS AT ITS CLOSING QUOTE. `§ "Location parity per file" is the authoritative
  // table.` names a section called "Location parity per file"; reading the trailing sentence as part
  // of the name is how a correct citation gets reported as a dead one. Same for `*emphasis*`.
  const quoted = /^(["'])(.+?)\1/.exec(s) ?? /^\*+([^*]+)\*+/.exec(s)
  if (quoted) return (quoted[2] ?? quoted[1] ?? '').trim()

  // AN UNQUOTED NAME ENDS AT A QUOTE NO LETTER FOLLOWS, ONCE THE NAME HAS BEGUN: the quote closing a
  // string literal the whole pointer sits in, as in `includes('docs/decisions.md § D-20')`, which the
  // gate read as a section called "D-20'" once it read unbackticked names (2026-10-03). An
  // apostrophe inside a name, `Reviewer's`, has a letter after it and is kept. The name begins at
  // its first character that is not a space, quote, `*` or `_`. Cut at the name's own opening quote
  // instead, as the first version of that change cut,
  // `§ "3.2 Three names` with no closing quote on its line and `§ "1) Foo"`, which the bracket ends
  // at `"1`, became empty names, and an empty name is dropped as no citation, where the gate before
  // it read `3.2 Three names` and `1` (found by that change's branch review, 2026-10-03). A name cut
  // after its first character keeps the character `looksLikeSectionName` reads, and is a prefix of
  // the uncut name, which `namesSection` matches by prefix: the cut fails no pointer that passed,
  // unless it leaves a one-character name that is not a number, which that match skips as too short.
  const unclosed = s.replace(/(?<=[^\s"'*_].*)["'](?![A-Za-z]).*$/, '')
  const withoutLine = unclosed.replace(/\s*\((?:line|lines)\s+\d+(?:[-–]\d+)?\)?\s*$/i, '').trim()
  const m = /^["'*_]+(.+?)["'*_]+$/.exec(withoutLine)
  return (m ? (m[1] as string) : withoutLine).replace(/^["'*_]+/, '').trim()
}

/** Markdown ATX headings of a document, as their text. */
export function headingsOf(lines: readonly string[]): string[] {
  return lines
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/[*_`"]/g, '')
        .trim(),
    )
}

/** A line reduced to the text a section name would be written as. */
const bare = (l: string): string =>
  l
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/[*_`"]/g, '')
    .trim()
    .toLowerCase()

/**
 * Whether any section of `lines` is named by `section`.
 *
 * NOT ATX-ONLY, and that matters here more than it would in most repositories: the prompt files use
 * bare uppercase labels as section markers. `archetype-classification.md` has no `#` heading in it
 * anywhere and its sections are lines reading `STALE WHEN` and `CONFIDENCE`; `DATABASE CHANGE
 * POLICY` in a second prompt is the same. A checker that recognised only `#` would
 * report every citation into those files as a dead section, which is a gate nobody could make green.
 * So a section is any line that BEGINS with the name -- heading or not.
 *
 * By PREFIX on the name, too, because prose runs straight on past the heading it names: "§
 * Measurement gives the failure condition for this node" cites a section called "Measurement".
 * Successive trailing words are dropped until something matches, so the assertion is the honest one:
 * does ANY leading part of what was written name a real section? A citation whose very first word
 * begins no line of the file is what this fails on, and that is the case that has actually bitten.
 *
 * The direction of the remaining error is deliberate. Matching any line, not just headings, lets a
 * table row or a body sentence satisfy a citation it was not meant to. That is a false PASS, and for
 * a floor gate a false pass costs a defect this run while a false FAIL costs the gate itself.
 */
export function namesSection(section: string, lines: readonly string[]): boolean {
  const candidates = lines.map(bare).filter(Boolean)
  // An ATX heading matches by CONTAINMENT, not prefix. Headings here regularly carry a part or node
  // qualifier ahead of the name a citation uses -- `## PART 5 — a node` is cited as `§ a node` --
  // and requiring the citation to reproduce the whole heading would fail every one of them.
  const headings = headingsOf(lines).map((h) => h.toLowerCase())
  const words = section
    .replace(/[*_`"]/g, '')
    .split(/\s+/)
    .filter(Boolean)

  // NUMBERED SECTIONS FIRST. `§5`, `§3.2`, `§5.3` and `§3.2/§3.5` name headings written `## 5. The
  // models in play` and `### 3.2 Three names in the brief`. The number alone is one character, so
  // the word-prefix loop below skips it as too short to be distinctive -- which it is as free text
  // and is not as a section number. Anchored to the number followed by a boundary so that `§5` does
  // not satisfy itself against `## 51.`.
  const numbered = /^(\d+(?:\.\d+)*)/.exec(words[0] ?? '')
  if (numbered) {
    const num = numbered[1] as string
    if (candidates.some((c) => new RegExp(`^${num.replace(/\./g, '\\.')}([.)\\s]|$)`).test(c))) {
      return true
    }
  }

  for (let n = words.length; n > 0; n--) {
    const probe = words
      .slice(0, n)
      .join(' ')
      .replace(/[.,;:)\]]+$/, '')
      .toLowerCase()
    if (probe.length < 2) continue
    if (candidates.some((c) => c.startsWith(probe))) return true
    if (headings.some((h) => h.includes(probe))) return true
  }
  return false
}

/**
 * Whether `§ <text>` is naming a SECTION at all, rather than running on into prose.
 *
 * Section names in this repository are capitalised (`§ Closure`, `§ INVARIANTS`, `§ Decision`), quoted
 * (`§ "Measured state"`) or numbered (`§5`). A lowercase first word means the `§` was used as a
 * preposition in a sentence -- `` `artifacts/report.md` § header, "Runtime" line `` means
 * the document's header block, not a heading called "header" -- and asserting a heading exists for
 * it would be the gate inventing a claim the author never made.
 */
export function looksLikeSectionName(section: string): boolean {
  const first = section.replace(/[*_`"]/g, '').trim()
  return /^[A-Z0-9]/.test(first)
}

/** Read a file's lines, cached. */
export function lineReader(): (path: string) => string[] {
  const cache = new Map<string, string[]>()
  return (path) => {
    let lines = cache.get(path)
    if (!lines) {
      lines = readFileSync(join(SCAN_ROOT, path), 'utf8').split('\n')
      cache.set(path, lines)
    }
    return lines
  }
}

export { SCANNED_EXTENSIONS }

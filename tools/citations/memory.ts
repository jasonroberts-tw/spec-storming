/**
 * Memory citations: pointers into a store this repository does not use.
 *
 * AGENTS.md § *Rules for agents live in tracked files, and nowhere else* gives every rule an agent
 * has to follow exactly one home, a tracked file, so two stores are NOT it: the
 * `bd remember` / `bd recall` / `bd memories` store and the harness's per-project auto-memory
 * directory. A prompt that says "see memory `some-key`" or tells its reader to `bd recall` one
 * points at a store that is empty here by rule, and it fails in the worst direction: the pointer
 * reads as authoritative, so the reader concludes they lack access rather than that the sentence
 * beside it is the whole rule. One skill re-acquired such citations three reviews running, and the fourth
 * review found that none of the five keys it cited resolved. That is why this is a gate and not a
 * convention, and why it runs where `citations:check` already runs: a memory
 * key is a citation whose target cannot exist, which is the resolution gate's failure taken to its
 * limit.
 *
 * WHAT IS A FINDING. Two shapes, taken exactly as written:
 *
 *   - a backticked span preceded by the word `memory` -- `` memory `bd-deps-blocks-direction` ``,
 *     the spelling a prompt review used for every key it named, including the line-wrapped
 *     form where the word ends one line and the key opens the next (the review's `(memory` on one
 *     line and `` `bd-deps-blocks-direction` `` on the one below);
 *   - the tokens `bd recall`, `bd remember` and `bd memories`, backticked or bare.
 *
 * A paragraph break between the word and the span is NOT a match: `stays in memory` closing one
 * paragraph and a code span opening the next are two sentences, not a citation. `bd forget` is not
 * matched either -- the three tokens are the bead's and no review found a fourth; widen the list
 * when one appears, with the review that found it.
 *
 * WHERE IT LOOKS. The prompt files and their shared sources: `.claude/`, `.codex/`, `.agents/`,
 * `.github/skills/`, `.github/agents/`, `.opencode/skills/`, `.opencode/agents/`, `.harness/`,
 * a workflow's own directory once one exists, `.beads/formulas/`, `.beads/PRIME.md`, `AGENTS.md`,
 * `CLAUDE.md` and `README.md` (`MEMORY_SCOPE`). `.beads/PRIME.md` is what `bd prime` prints, in place of its own text,
 * whenever the tracker's plugin runs it at a session's start or before a compaction; on 2026-10-03
 * that built-in text, which this repository had no file to replace, told every session "Use
 * `bd remember` for persistent knowledge across sessions". Every tracked
 * file under them regardless of extension, because the plugin's tools carry their prompts in `.ps1`
 * headers, which `scan.ts`'s `SCANNED_EXTENSIONS` does not cover; it covered no `.toml` formula
 * either until 2026-10-04.
 * A roster rather than the whole tree, unlike `scan.ts`, on purpose: the word `memory` before a
 * code span is ordinary prose in a tool's comment and a defect only where an agent reads it as an
 * instruction, and a whole-tree scan would begin by exempting this file.
 *
 * WHAT IS EXEMPT, and the design problem it answers. A section of AGENTS.md that forbids the store
 * has to name the commands it forbids, and the Beads block `bd`'s set-up can write into the file
 * would name them again: it says "Use `bd remember` for persistent knowledge", is regenerated from the hash in
 * its marker, and cannot be edited. No such block is written here: the tracker's text reaches a
 * session through `bd prime` and `.beads/PRIME.md`, which is in scope. Three ways to exempt those
 * mentions; this takes the third.
 *
 *   - NOT the whole of AGENTS.md. It is the most-read prompt in the repository and the roster puts
 *     it in scope by name; exempting it wholesale is the hole dressed as an exemption every list in
 *     `scan.ts` warns about.
 *   - NOT a line that also carries a negation. That is a semantic rule: it passes the generated
 *     line for the wrong reason (its negation is about `MEMORY.md`, not about `bd remember`) and it
 *     passes "never skip `bd remember`" too.
 *   - TWO REGIONS OF AGENTS.md, each keyed on its own delimiter (`MEMORY_EXEMPT_REGIONS`). The
 *     forbidding section by its `## ` heading text, from the heading to the next level-1 or level-2
 *     heading, on the argument `HISTORY` in `scan.ts` already makes for `tools/citations/`: it
 *     quotes the thing it exists to forbid. The generated block by `bd`'s own
 *     `<!-- BEGIN BEADS INTEGRATION` / `<!-- END BEADS INTEGRATION -->` markers, because those
 *     delimit exactly the region nobody can edit, and the headings inside them are `bd`'s to
 *     rename. A region applies to the one file it names, so the same heading in a skill exempts
 *     nothing and cannot be copied to route around the gate. And a registered region that is not
 *     found in its file is a FINDING, not a silent pass: rename the heading or lose the markers and
 *     the gate says so on the next run, rather than going quietly green over the whole file.
 *
 * NOTHING IS EXEMPT AS HISTORY. The rule once exempted a directory of prompt reviews, which quoted
 * the memory keys a skill cited in order to record that none resolved. The directory was deleted,
 * and the exemption went with it.
 *
 * Reads only this repository, needs no `../sibling` checkout and no network.
 */

/** The prompt homes the rule covers: a directory prefix (trailing `/`) or one exact file. */
export const MEMORY_SCOPE: ReadonlyArray<string> = [
  '.claude/',
  '.codex/',
  '.agents/',
  '.github/skills/',
  '.github/agents/',
  '.opencode/skills/',
  '.opencode/agents/',
  '.harness/',
  '.beads/formulas/',
  '.beads/PRIME.md',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
]

/** Whether the rule covers `file` at all. */
export function inMemoryScope(file: string): boolean {
  return MEMORY_SCOPE.some((s) => (s.endsWith('/') ? file.startsWith(s) : file === s))
}

/**
 * A region of ONE named file inside which the forbidden spellings are the rule stating itself.
 *
 * `section` names a `#` or `##` heading by its text; the region runs from that heading to the line
 * before the next `#` or `##` heading. `between` names a pair of line prefixes; the region runs from
 * the first line starting with the opener through the next line starting with the closer.
 */
export type ExemptRegion =
  | { file: string; section: string; why: string }
  | { file: string; between: readonly [string, string]; why: string }

export const MEMORY_EXEMPT_REGIONS: ReadonlyArray<ExemptRegion> = [
  {
    file: 'AGENTS.md',
    section: 'Rules for agents live in tracked files, and nowhere else',
    why:
      'The section that forbids the store names the commands it forbids, exactly as' +
      ' `tools/citations/` quotes the citations it exists to catch. Keyed on the heading text, so' +
      ' renaming the heading turns every mention in the section into a finding until this entry' +
      ' follows it.',
  },
  // NO TRACKER BLOCK IS REGISTERED. The tracker's plugin reaches a session through `bd prime`, which
  // prints `.beads/PRIME.md`, a file in `MEMORY_SCOPE` held to this rule like any prompt, and nothing
  // writes a block into AGENTS.md. Should `bd`'s set-up ever write one, which tells its reader to use
  // the memory commands and cannot be edited, register it keyed on its own markers:
  //   { file: 'AGENTS.md', between: ['<!-- BEGIN BEADS INTEGRATION', '<!-- END BEADS INTEGRATION -->'], why: '...' },
  // Registered BEFORE the block exists it is a finding, by the rule in the header: a region that is
  // not found is reported, never silently passed.
]

/** A registered region located in a file: 1-based, inclusive. */
export interface FoundRegion {
  first: number
  last: number
  why: string
}

const HEADING_RE = /^#{1,2}\s/

function sectionSpan(
  heading: string,
  lines: readonly string[],
): { first: number; last: number } | null {
  const start = lines.findIndex(
    (l) => HEADING_RE.test(l) && l.replace(/^#{1,2}\s+/, '').trim() === heading,
  )
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !HEADING_RE.test(lines[end] ?? '')) end++
  // `end` is the 0-based index of the next heading (or one past the last line), so the region's
  // last 1-based line is `end` itself: the line before that heading.
  return { first: start + 1, last: end }
}

function markerSpan(
  [begin, close]: readonly [string, string],
  lines: readonly string[],
): { first: number; last: number } | null {
  const first = lines.findIndex((l) => l.startsWith(begin))
  if (first < 0) return null
  const last = lines.findIndex((l, i) => i > first && l.startsWith(close))
  if (last < 0) return null
  return { first: first + 1, last: last + 1 }
}

/**
 * The registered regions of `file`, located in its `lines` -- and the registered regions that
 * could NOT be located, which the caller must report. An exemption matching nothing is a hole
 * dressed as an exemption, and here it would be a hole over the one file that matters most.
 *
 * `regions` is the registry, and the gate always passes the live one by default. The selftest
 * passes a synthetic one, so that both region shapes stay exercised whichever of them this
 * repository has registered today.
 */
export function exemptRegionsIn(
  file: string,
  lines: readonly string[],
  regions: ReadonlyArray<ExemptRegion> = MEMORY_EXEMPT_REGIONS,
): { found: FoundRegion[]; missing: ExemptRegion[] } {
  const found: FoundRegion[] = []
  const missing: ExemptRegion[] = []
  for (const r of regions) {
    if (r.file !== file) continue
    const span = 'section' in r ? sectionSpan(r.section, lines) : markerSpan(r.between, lines)
    if (span) found.push({ ...span, why: r.why })
    else missing.push(r)
  }
  return { found, missing }
}

/** The reason line `at` is exempt, or null when no found region covers it. */
export function regionReason(at: number, found: readonly FoundRegion[]): string | null {
  return found.find((r) => at >= r.first && at <= r.last)?.why ?? null
}

/** How a registered region is spelled in a report. */
export function describeRegion(r: ExemptRegion): string {
  return 'section' in r
    ? `section "## ${r.section}"`
    : `the lines between ${r.between.join(' and ')}`
}

/** One forbidden spelling, as written. */
export interface MemoryCitation {
  /** Repository-relative path of the file it is written in. */
  from: string
  /** 1-based line the match begins on. */
  at: number
  /** `key` for `` memory `x` ``, `token` for `bd recall` / `bd remember` / `bd memories`. */
  kind: 'key' | 'token'
  /** The match as written, whitespace collapsed. */
  text: string
  /** The source line(s) the match spans, trimmed and joined. */
  context: string
}

/**
 * `` memory `key` ``, case-insensitive on the word, with at most ONE line break between the word
 * and the span. `[ \t]*(?:\r?\n[ \t]*)?` is the line-wrapped spelling the review records; a second
 * newline would be a paragraph break, which is two sentences and not a citation. `(?<!-)` refuses
 * a hyphenated compound -- `in-memory `index.json``, `auto-memory` -- where `\b` alone would not,
 * because a hyphen is a word boundary.
 */
const KEY_RE = /(?<!-)\bmemory\b[ \t]*(?:\r?\n[ \t]*)?`[^`\n]+`/gi

/** The three `bd` memory-store commands, as tokens. Case-sensitive: `bd` is the binary's name. */
const TOKEN_RE = /\bbd[ \t]+(?:recall|remember|memories)\b/g

/** Every forbidden spelling in `text`, which is the content of `from`, in line order. */
export function memoryCitationsIn(from: string, text: string): MemoryCitation[] {
  const lines = text.split('\n')
  const out: MemoryCitation[] = []
  const shapes: ReadonlyArray<readonly [RegExp, MemoryCitation['kind']]> = [
    [KEY_RE, 'key'],
    [TOKEN_RE, 'token'],
  ]
  for (const [re, kind] of shapes) {
    for (const m of text.matchAll(re)) {
      const at = text.slice(0, m.index).split('\n').length
      const spanned = m[0].split('\n').length
      out.push({
        from,
        at,
        kind,
        text: m[0].replace(/\s+/g, ' '),
        context: lines
          .slice(at - 1, at - 1 + spanned)
          .map((l) => l.trim())
          .join(' '),
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export interface MemoryProblem {
  where: string
  what: string
  context: string
}

/** The whole rule applied to one file: what `check.ts` reports and what the selftest asserts. */
export interface MemoryScan {
  /** Why the file was not scanned at all, or null when it was. */
  skipped: string | null
  problems: MemoryProblem[]
  /** Forbidden spellings inside a registered exempt region. */
  exempted: number
}

const RULE = 'AGENTS.md § *Rules for agents live in tracked files, and nowhere else*'

/**
 * Scope, registered regions and the two shapes, in that order, over one file's text.
 *
 * ONE FUNCTION rather than a pipeline the gate assembles, so that the selftest exercises the exact
 * derivation `check.ts` runs: a fixture that fails here fails the gate, and a fixture that passes
 * here passes it, with nothing in between to drift. `regions` defaults to the live registry, which
 * is what `check.ts` uses; only the selftest passes another (see `exemptRegionsIn`).
 */
export function memoryProblemsIn(
  file: string,
  text: string,
  regions: ReadonlyArray<ExemptRegion> = MEMORY_EXEMPT_REGIONS,
): MemoryScan {
  if (!inMemoryScope(file)) {
    return {
      skipped: `outside MEMORY_SCOPE (${MEMORY_SCOPE.join(', ')})`,
      problems: [],
      exempted: 0,
    }
  }
  // A NUL means the file is binary whatever its name. Nothing to read as a prompt.
  if (text.includes('\0')) return { skipped: 'binary', problems: [], exempted: 0 }

  const lines = text.split('\n')
  const { found, missing } = exemptRegionsIn(file, lines, regions)
  const problems: MemoryProblem[] = []
  for (const r of missing) {
    problems.push({
      where: file,
      what:
        `registers ${describeRegion(r)} as exempt from the memory rule, but no such region is in the` +
        ' file. The heading was renamed or the markers are gone; without the region every mention' +
        ' it covered is live, so the gate reports the exemption rather than silently keeping it.' +
        ' Repoint the entry in `MEMORY_EXEMPT_REGIONS` (`tools/citations/memory.ts`).',
      context: r.why,
    })
  }
  let exempted = 0
  for (const c of memoryCitationsIn(file, text)) {
    if (regionReason(c.at, found) !== null) {
      exempted++
      continue
    }
    problems.push({
      where: `${file}:${c.at}`,
      what:
        c.kind === 'key'
          ? `cites ${c.text}. This repository keeps no memory store (${RULE}), so the key resolves` +
            ' to nothing and a reader following it concludes they lack access. State the rule in' +
            ' this file, or cite the tracked file that carries it.'
          : `tells its reader to \`${c.text}\`. The store is not used here (${RULE}); a prompt that` +
            ' names the command sends its reader to an empty store. Name the tracked file that' +
            ' holds the fact instead, or cite the AGENTS.md section if the sentence is the rule.',
      context: c.context,
    })
  }
  return { skipped: null, problems, exempted }
}

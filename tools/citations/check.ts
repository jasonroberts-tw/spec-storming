/**
 * `mise run citations:check` -- does every `<file>.md:NN` and `<file>.md § <Name>` citation in this
 * repository, its file name backticked or not, resolve to what it names?
 *
 * `tools/citations/scan.ts` carries the reasoning: why this scans everything rather than an
 * allowlist, why quotations are exempt, and why it checks that a pointer resolves and leaves what the
 * passage says to a reader. This file is the gate over the real repository.
 *
 * FIVE FAILURES, all of them the silent kind.
 *
 *   1. The named file does not exist. It was moved or retired and the citation was left behind.
 *   2. The cited line is past the end of the file. The file shrank underneath the pointer.
 *   3. The cited line is BLANK. The file grew above the pointer and it slid off the passage -- the
 *      most common shape, and the one that reads as authoritative right up until you follow it.
 *   4. The cited SECTION does not exist. Either the heading was renamed, or -- the pathological
 *      version, which has happened -- the file has no headings at all and never did.
 *   5. The cited target is a MEMORY KEY, or the sentence tells its reader to `bd recall` one. The
 *      store is not used here (AGENTS.md § *Rules for agents live in tracked files, and nowhere
 *      else*), so the pointer can never resolve. `tools/citations/memory.ts` carries the rule: its
 *      roster of prompt homes, and the regions of AGENTS.md registered in `MEMORY_EXEMPT_REGIONS`
 *      -- the section that forbids the store, and the `bd`-generated block once it exists -- exempt
 *      by heading and by marker rather than the file as a whole.
 *
 *   mise run citations:check                        the gate, over this checkout
 *   CITATIONS_ROOT=<dir> mise run citations:check   the same gate over a doctored copy (a git tree)
 *   CITATIONS_UNTRACKED=1 mise run citations:check  also reads untracked files git does not ignore
 *                                                  (`INCLUDE_UNTRACKED`)
 *
 * Needs no `../sibling` checkout and no network; it reads tracked files, and untracked ones when
 * asked, and runs in about a second.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HISTORY,
  INCLUDE_UNTRACKED,
  SCAN_ROOT,
  SCANNED_EXTENSIONS,
  citationsIn,
  headingsOf,
  historyReason,
  indexByName,
  isQuoted,
  lineReader,
  namesSection,
  resolveTarget,
  trackedFiles,
  untrackedFiles,
} from './scan.ts'
import { inMemoryScope, memoryProblemsIn } from './memory.ts'

interface Problem {
  where: string
  what: string
  context: string
}

const problems: Problem[] = []

// With `CITATIONS_UNTRACKED=1` the untracked files join the roster as if tracked, so a pointer in
// one is checked and a pointer to one resolves: both are about to be committed together.
const untracked = INCLUDE_UNTRACKED ? untrackedFiles() : []
const tracked = [...trackedFiles(), ...untracked]
const trackedSet = new Set(tracked)
// `isDeliveredPackage` ONCE FILTERED THIS, on both sides: a delivered handoff package copied
// ~60 documents under new paths, so a bare basename could resolve into a copy and five long-standing
// citations elsewhere in the tree became ambiguous the moment slice 004's package landed. Every
// package was later deleted, so the whole roster is indexed again -- an exclusion
// matching nothing is a hole in this gate rather than a saving, and a hand-made `handoff/` directory
// would have inherited it silently.
const byName = indexByName(tracked)
const linesOf = lineReader()

let scannedFiles = 0
let exemptFiles = 0
let checked = 0
let sections = 0
let quoted = 0

for (const file of tracked) {
  if (!SCANNED_EXTENSIONS.test(file)) continue
  if (historyReason(file)) {
    exemptFiles++
    continue
  }

  let text: string
  try {
    text = readFileSync(join(SCAN_ROOT, file), 'utf8')
  } catch {
    continue
  }
  // A NUL means the extension lied about the contents. Skip rather than fail: this gate has no
  // opinion about binaries that happen to be named `.json`.
  if (text.includes('\0')) continue
  scannedFiles++

  for (const c of citationsIn(file, text)) {
    const where = `${c.from}:${c.at}`
    const asWritten =
      c.kind === 'line'
        ? `${c.target}:${c.first}${c.last === c.first ? '' : `-${c.last}`}`
        : `${c.target} § ${c.section}`
    if (isQuoted(c.from, asWritten)) {
      quoted++
      continue
    }
    const resolved = resolveTarget(c.from, c.target, trackedSet, byName)
    if ('error' in resolved) {
      problems.push({ where, what: resolved.error, context: c.context })
      continue
    }

    const lines = linesOf(resolved.path)

    if (c.kind === 'line') {
      checked++
      if (c.first < 1 || c.last > lines.length) {
        problems.push({
          where,
          what:
            `cites ${c.target}:${c.first}${c.last === c.first ? '' : `-${c.last}`}, but` +
            ` ${resolved.path} has ${lines.length} lines. The pointer is past the end of the file.`,
          context: c.context,
        })
        continue
      }
      if ((lines[c.first - 1] ?? '').trim() === '') {
        problems.push({
          where,
          what:
            `cites ${c.target}:${c.first}, which is a BLANK line of ${resolved.path}. The passage` +
            ' moved and the citation did not. Repoint it, or better, cite the passage by a distinctive' +
            ' phrase that is resolved by content and cannot drift.',
          context: c.context,
        })
      }
      continue
    }

    sections++
    if (namesSection(c.section, lines)) continue
    if (!headingsOf(lines).length) {
      problems.push({
        where,
        what:
          `cites \`${c.target}\` § ${c.section}, but ${resolved.path} has NO markdown headings at` +
          ' all, so no section of it can be cited. This is the shape `verify-layout.md` was in' +
          ' while five places cited a `§S-BASELINE` of it that had never existed.',
        context: c.context,
      })
      continue
    }
    problems.push({
      where,
      what:
        `cites \`${c.target}\` § ${JSON.stringify(c.section)}, but no section of ${resolved.path}` +
        ' is named that. Either the heading was renamed, or the section is in a different document.',
      context: c.context,
    })
  }
}

/* ----------------------------------------------------------------------------------------------- *
 * The memory rule
 *
 * A second pass rather than a fifth branch of the loop above, because that loop is filtered by
 * `SCANNED_EXTENSIONS` and this rule covers every tracked file in its roster whatever the
 * extension: the plugin's tools carry their prompts in `.ps1` headers, which that loop never reads.
 * `tools/citations/memory.ts` is the whole rule -- roster, the registered AGENTS.md regions and the
 * two shapes -- and `memoryProblemsIn` is the one function the selftest holds to fixtures, so what
 * fails there fails here and nothing in between can drift.
 * ----------------------------------------------------------------------------------------------- */

let memoryFiles = 0
let memoryExempt = 0
const memorySkipped: string[] = []

for (const file of tracked) {
  // The files the rule has an opinion about: its roster.
  if (!inMemoryScope(file)) continue
  let text: string
  try {
    text = readFileSync(join(SCAN_ROOT, file), 'utf8')
  } catch {
    continue
  }
  const scan = memoryProblemsIn(file, text)
  if (scan.skipped !== null) {
    memorySkipped.push(file)
    continue
  }
  memoryFiles++
  memoryExempt += scan.exempted
  problems.push(...scan.problems)
}

/* ----------------------------------------------------------------------------------------------- *
 * Report
 * ----------------------------------------------------------------------------------------------- */

console.log(
  `citations:check -- ${checked} line citations and ${sections} section citations across` +
    ` ${scannedFiles} files (${exemptFiles} files and ${quoted} citations exempt as history);` +
    ` memory rule over ${memoryFiles} prompt files (${memoryExempt} mentions exempt inside` +
    " AGENTS.md's registered regions" +
    (memorySkipped.length
      ? `; ${memorySkipped.length} files skipped as binary: ${memorySkipped.join(', ')}`
      : '') +
    ')' +
    (INCLUDE_UNTRACKED ? `; untracked files read too (CITATIONS_UNTRACKED=1): ${untracked.length}` : '') +
    '\n',
)

if (problems.length) {
  console.error(`${problems.length} unresolvable citation(s):\n`)
  for (const p of problems) {
    console.error(`  ${p.where}`)
    console.error(`    ${p.what}`)
    console.error(`    > ${p.context.slice(0, 160)}\n`)
  }
  console.error(
    'A citation that does not resolve is worse than no citation: it reads as authoritative, so a' +
      '\nreader who follows it and finds nothing concludes they have misunderstood. Fix the pointer,' +
      '\nor -- if the file is a record of what a past claim SAID -- add it to `HISTORY` in' +
      '\n`tools/citations/scan.ts` with the reason. A memory citation is fixed in the prompt that' +
      '\ncarries it; `tools/citations/memory.ts` says what is exempt and why.\n',
  )
  console.error(`Exempt as history: ${HISTORY.map((h) => h.path).join(', ')}`)
  process.exit(1)
}

console.log(
  'Every citation resolves to the file, line and section it names, and no prompt cites a memory key.',
)

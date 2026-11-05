/**
 * Every bead in the tracker stands on its own: an open bead a run filed `discovered-from` another
 * names the kinds of file its work would change, an open bead's type is one the rubric describes,
 * and every identifier it cites resolves from THIS checkout.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. A bead is a set of instructions an agent executes months
 * after a human wrote it, and the tracker is the only thing that travels with it. When a bead cites
 * an id from another repository's tracker for the rule that justifies the gate it is asking for,
 * that id resolves in a DIFFERENT repository's database, on one developer's laptop. `bd show`
 * errors on it here. The fact does not travel; only a pointer to it does, and the pointer is dead
 * everywhere except the machine it was written on.
 *
 * That is not hypothetical. One bead cited a predecessor id, an emitter hard-coded the same id,
 * and it was PUBLISHED into a generated artifact as the stated authority for a hard exclusion
 * rule. The smell escaped the tracker and shipped.
 *
 * AN UNLABELLED FOUND ISSUE IS A HOLE IN A COUNT, AND THE COUNT DOES NOT SHOW IT. Labels took the
 * place of a retired run-outcome learning loop: an issue a run files
 * `discovered-from` the issue it ran on carries a label that `assetLabels` in
 * `policy/vocabulary.json` lists for each kind of file its work would change, so `bd count --by-label` shows what keeps
 * needing a fix. On 2026-09-26 a fan-out sweep's investigator found two issues open with no such
 * label: both were filed `discovered-from` on 2026-09-23, the day before the labels were decided,
 * and nothing had asked for the label since.
 * The count left both out and read the same as a complete one. The sweep labelled them by hand, and
 * rule 3 below refuses the next one.
 *
 * A TYPE NO ROW DESCRIBES IS ONE NO FILER WAS TOLD WHEN TO USE. Until 2026-10-03 nothing said which
 * type an issue takes, and every filer but two took `bd`'s default. The tracker drifted: three
 * tasks filed from 2026-10-01 to 2026-10-03 carry the `## Steps to Reproduce` that `bd lint` asks of
 * a bug. The answer was a rubric, `issueTypes`, rows tried in
 * order, and rule 4 holds only its vocabulary: it refuses an open bead whose type no row names, so a
 * filer who reaches for `story` or `milestone`, which `bd create --help` also lists, finds the
 * rubric. Wrong, it would pass a type the rubric never describes, and `bd count --by-type` would
 * split what no one chose to split. It cannot catch the drift itself: whether the row a filer chose
 * is the one that fits, like an issue's priority, is a judgement no check can make.
 *
 * WHY A REGISTRY RATHER THAN A BAN. A bead that CORRECTS a stale foreign citation has to name the
 * id it is correcting, so a flat prohibition would forbid the fix along with the defect. This is the
 * same trade `tools/citations/scan.ts` makes with its `QUOTED` list, and the same reasoning: each
 * exemption is registered individually, with a reason, rather than by a wholesale exemption that
 * would stop saying anything.
 *
 * WHY THE LIVE RUN IS NOT A CI STEP, AND ITS SELFTEST IS. The live run reads the Dolt database
 * through `bd export`. CI has no database, though mise installs the binary there, so it would
 * compare against nothing and pass. It is a `pre-push` job.
 * Where `bd` is unavailable it SKIPS CLEAN and says so -- a
 * gate that is red on every fresh clone gets bypassed with `--no-verify`, which costs you every other
 * gate too. `--selftest` reads only the fixtures it writes and the committed records under
 * `policy/`, and runs no `bd`, so it is a pre-push job and a `.github/workflows/verify.yml` step both
 * (`AGENTS.md` § The gate ladder).
 *
 * "UNAVAILABLE" MEANS NOT FOUND, AND NOTHING ELSE. `tools/lib/bd-launcher.ts` resolves `bd` on PATH
 * and starts it without a shell; only its `found: false` answer is a skip. A `bd` that IS found and
 * then cannot be started, exits non-zero, or writes nothing is a FAILURE, printed with the launcher
 * and the spawn error, because the mirror of the paragraph above happened: on native Windows `bd` is
 * the npm shim `%APPDATA%\npm\bd`, `execFileSync('bd')` threw ENOENT on it, and this gate reported
 * "skipped" over a tracker that `bd export` in the same shell had just written 107 issues from.
 * A green run prints the bead count it read and which `bd` it read
 * through, so it cannot be mistaken for the skip in a pre-push log.
 *
 * FOUR HARD FAILURES:
 *
 *   1. An unregistered id carrying PREDECESSOR_PREFIX in any bead field: an id from the predecessor
 *      repository's tracker. Register it below with a reason, or copy the fact in. With no
 *      predecessor, PREDECESSOR_PREFIX stays null and this rule goes.
 *   2. A bead whose work lands in a foreign repository and which does not cite its context bead.
 *      Those beads carry the copied bundle facts; a cross-repo bead that does not point at one is
 *      asking the reader to go and open another checkout.
 *   3. An open bead with a `discovered-from` dependency and no label that `assetLabels` in
 *      `policy/vocabulary.json` lists. The list is read from the policy on every run and
 *      spelled nowhere here, so a label added there is accepted at once, and a label renamed there
 *      strands every issue that carries the old spelling, as `assetLabelsMeans` warns. A closed bead
 *      is exempt: the count is read for what is still to fix. A policy with no such list, or an
 *      empty one, is a failure, never a pass over nothing.
 *   4. An open bead whose type no row of `issueTypes` in `policy/vocabulary.json` names. The
 *      types are read from the policy on every run and spelled nowhere here, so a row added there is
 *      accepted at once, and a row renamed or removed there refuses every open bead of the old type,
 *      as `issueTypesMeans` warns. A closed bead keeps the type it closed with. A policy with no
 *      such array, an empty one, or a row with no type is a failure, never a pass over nothing.
 *
 * "Open" is every status but `closed`, for rules 2 to 4. Plus one consistency check: a context bead
 * cited by rule 2 must itself exist in the export, so this gate cannot be satisfied by pointing at an
 * id that is as dead as the ones it forbids.
 *
 * INVOCATION.
 *
 *   mise run beads:check                         the gate, over what `bd export` writes
 *   mise run beads:selftest                      its refusals over a fixture export (--selftest)
 *   BEADS_CHECK_ROOT=<dir> mise run beads:check  the gate over a doctored copy
 *
 * ROOT OVERRIDE. `BEADS_CHECK_ROOT` names a doctored copy: a directory holding the policy's records
 * under `policy/` and `export.jsonl`, one issue per line in the shape `bd export` writes. The gate then reads both from
 * there and runs no `bd`. A copy with no export is a failure, never a fall-back to the live tracker
 * or a skip.
 *
 * NEGATIVE TESTING. `--selftest` writes a fixture export and a copy of the committed policy under
 * `os.tmpdir()`, doctors ONE thing per case, runs this gate on it as a child process through
 * `BEADS_CHECK_ROOT`, and asserts the run fails FOR THAT REASON. Its undoctored control must pass and
 * must print the fixture's bead count and the override, so neither a skip nor a read of the live
 * tracker can pass for it. Rules 1 and 2 have nothing configured yet (PREDECESSOR_PREFIX is null and
 * CONTEXT_BEAD is empty), so no case breaks them; the case for each lands with its first entry.
 * Thirteen gate runs, one Node process each: 1.31 to 1.40 s wall for `node scripts/check-beads.mjs
 * --selftest` (`/usr/bin/time -p`, two runs) on a macOS 26.7.1 laptop (Apple M3 Max) with Node
 * 26.11.1, 2026-10-11.
 *
 * NEEDS `bd` on PATH for the live run, and skips clean without it. The override and the selftest
 * need nothing but Node: no `bd`, no network.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { describeLauncher, resolveBd, runBd } from '../tools/lib/bd-launcher.ts'
import { POLICY_DIR, copyPolicy, editPolicy, readPolicy } from '../tools/lib/policy.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT_ENV = 'BEADS_CHECK_ROOT'
/** The doctored copy a by-hand run or the selftest names; unset or empty means the live tracker. */
const OVERRIDE = process.env[ROOT_ENV] || null
const ROOT = OVERRIDE ?? REPO_ROOT
/** The policy record that holds the key, named in a refusal; the key is read from every record merged. */
const POLICY = `${POLICY_DIR}/vocabulary.json`
const POLICY_KEY = 'assetLabels'
const TYPES_KEY = 'issueTypes'
/** Under the override, the export sits here, where `bd export` would have written it. */
const OVERRIDE_EXPORT = 'export.jsonl'

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The predecessor tracker's id prefix, and this tracker's own. With no predecessor repository,
 * PREDECESSOR_PREFIX stays null and rule 1 goes. A foreign id is the predecessor's prefix plus
 * hyphenated alphanumeric tokens, optionally with a `.N` sub-id.
 *
 * A FILENAME IS NOT AN ID. A tracker export's filename, spelled with the prefix, matched the first
 * cut of this pattern and was reported against the very bead that proposed the filename, which is
 * the failure mode a gate like this has to avoid: a false positive teaches people that the gate is
 * noise. Matches followed by a file extension are dropped below rather than excluded in the
 * pattern, because doing it in the pattern lets backtracking find a shorter bogus match and report
 * that instead.
 */
const PREDECESSOR_PREFIX = null
const OWN_PREFIX = null
const FOREIGN_ID = PREDECESSOR_PREFIX
  ? new RegExp(`\\b${PREDECESSOR_PREFIX}-[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.\\d+)?`, 'gi')
  : null

/** A match immediately followed by `.<ext>` is a filename, not a bead id. */
const EXTENSION_AFTER = /^\.[a-z]{2,5}\b/i

/**
 * A BRANCH NAME IS NOT AN ID EITHER. A branch named with the predecessor's prefix, quoted by the
 * notes that record work landing on it, matches FOREIGN_ID and resolves in no tracker anywhere; so
 * does an adjective built on the prefix. Each is listed by exact literal with its reason, like
 * QUOTED_IDS and unlike a pattern, so that no real predecessor id can ride in on the exemption.
 * Check every entry against the frozen predecessor export first: a token that DOES hit there is a
 * real id and belongs in QUOTED_IDS instead.
 *
 * Shape: { token: 'the literal, lower case', why: 'why it is not an id' }
 */
const NOT_IDS = []

/**
 * Foreign ids that MAY appear, each with the reason. Three reasons are on this list today, and a new
 * entry should be rare enough to argue for in review:
 *
 *   - A correction note has to name the id it is correcting (most entries).
 *   - A bead that carries a predecessor chore forward has to name the chore it is carrying, and it
 *     qualifies only because it copies the fact in and cites the in-repo files that hold it.
 *   - A bead about the foreign ids themselves -- the residue list, the export's coverage -- has to
 *     name the ids it is reporting on.
 *
 * Every id here resolves in `history/predecessor-tracker.jsonl` (`grep '"id":"<id>"'`); one that
 * does not is not an id and belongs in NOT_IDS.
 */
// Shape: { bead: 'the citing bead', id: 'the foreign id', why: 'the reason it may appear' }
const QUOTED_IDS = []

/**
 * A bead whose work lands outside this repository must cite the bead carrying that surface's copied
 * facts. The context beads are closed on purpose: they are reference, not work.
 *
 * Shape: a `repo:` label naming a foreign repository, mapped to the id of its context bead. Empty
 * until work lands outside this repository.
 */
const CONTEXT_BEAD = {}

const FIELDS = ['description', 'acceptance_criteria', 'design', 'notes']

const textOf = (bead) => FIELDS.map((f) => (typeof bead[f] === 'string' ? bead[f] : '')).join('\n')

/** One issue per non-empty line, or the reason the lines are not an export. */
function parseExport(text, source) {
  const lines = text.split('\n').filter((l) => l.trim())
  try {
    return { kind: 'ok', beads: lines.map((l) => JSON.parse(l)) }
  } catch (err) {
    return {
      kind: 'failed',
      detail: `${source} holds ${String(lines.length)} line(s) that do not parse as JSONL: ${err.message}`,
    }
  }
}

/**
 * Three outcomes, and only the first is a skip:
 *
 *   { kind: 'absent', reason }        no `bd` on PATH at all -- a fresh clone, CI
 *   { kind: 'failed', detail }        a `bd` was found and the export did not happen, or the
 *                                     override names a copy whose export is missing or unreadable
 *   { kind: 'ok', beads, through }    the export, parsed, and where it was read from
 *
 * Nothing here catches an error into "absent": the only route to a skip is the resolver saying the
 * command does not exist, and under the override no route leads there.
 */
function loadBeads() {
  if (OVERRIDE) {
    const path = join(OVERRIDE, OVERRIDE_EXPORT)
    if (!existsSync(path)) {
      return {
        kind: 'failed',
        detail:
          `${ROOT_ENV} names ${OVERRIDE}, which holds no ${OVERRIDE_EXPORT}. A doctored copy carries ` +
          'the export `bd export` would have written; this gate never falls back to the live tracker.',
      }
    }
    const parsed = parseExport(readFileSync(path, 'utf8'), path)
    return parsed.kind === 'ok' ? { ...parsed, through: `${path} (${ROOT_ENV})` } : parsed
  }

  const resolved = resolveBd()
  if (!resolved.found) return { kind: 'absent', reason: resolved.reason }
  if (!resolved.runnable) {
    return {
      kind: 'failed',
      detail: `\`bd\` was found at ${resolved.location} but cannot be started: ${resolved.reason}`,
    }
  }
  const { launcher } = resolved
  const through = describeLauncher(launcher)
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), 'beads-check-'))
    const out = join(dir, 'export.jsonl')
    const run = runBd(launcher, ['export', '--output', out])
    if (run.error) {
      return { kind: 'failed', detail: `spawning ${through} failed: ${run.error.message}` }
    }
    if (run.status !== 0) {
      return {
        kind: 'failed',
        detail:
          `\`bd export\` through ${through} exited ${String(run.status)}` +
          (run.stderr.trim() ? `:\n    ${run.stderr.trim().split('\n').join('\n    ')}` : ''),
      }
    }
    if (!existsSync(out)) {
      return {
        kind: 'failed',
        detail: `\`bd export\` through ${through} exited 0 and wrote nothing at ${out}`,
      }
    }
    const parsed = parseExport(readFileSync(out, 'utf8'), `the file \`bd export\` wrote through ${through}`)
    return parsed.kind === 'ok' ? { ...parsed, through } : parsed
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** Every record under `root`, merged, or the reason they cannot be read. */
function loadPolicy(root) {
  try {
    return { policy: readPolicy(root) }
  } catch (err) {
    return {
      error:
        `${POLICY_DIR}/ cannot be read under ${root} (${err.message}). Rules 3 and 4 read their lists ` +
        'from it, and with none they would pass every issue without looking.',
    }
  }
}

/**
 * The labels `key` lists in the policy, or the reason there are none to read. `rule` is the rule that
 * reads them and `values` what each value of the key says, both for the refusal.
 */
function loadLabels(policy, key, rule, values) {
  const value = policy?.[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return {
      error:
        `${POLICY} has no \`${key}\` object with at least one label: each key is a label and each ` +
        `value ${values}. Rule ${rule} reads the labels \`${key}\` lists from it, and with no list it would ` +
        'pass every found issue without looking.',
    }
  }
  return { labels: new Set(Object.keys(value)) }
}

/** The types the rows of `issueTypes` name, in their order, or the reason there are none to read. */
function loadIssueTypes(policy) {
  const rows = policy?.[TYPES_KEY]
  const types = Array.isArray(rows) ? rows.map((row) => row?.type).filter((t) => typeof t === 'string' && t !== '') : []
  if (types.length === 0 || types.length !== rows.length) {
    return {
      error:
        `${POLICY} has no \`${TYPES_KEY}\` array whose every row names a \`type\`: each row is a type and ` +
        'when it applies. Rule 4 reads the types from it, and with none it would pass every type without looking.',
    }
  }
  return { types: new Set(types) }
}

/**
 * Every rule over `beads`. `assetLabels` and `issueTypes` are the sets rules 3 and 4 read; each is
 * null when the policy gave none, which the caller has already reported, so no rule repeats it once
 * per bead.
 */
function runCheck(beads, assetLabels, issueTypes) {
  const failures = []
  const isQuoted = (bead, id) =>
    QUOTED_IDS.some((q) => q.bead === bead && q.id.toLowerCase() === id.toLowerCase())

  const known = new Set(beads.map((b) => b.id))

  for (const bead of beads) {
    const text = textOf(bead)
    const labels = bead.labels ?? []
    const closed = bead.status === 'closed'

    // 1. Unregistered foreign ids.
    for (const m of FOREIGN_ID ? text.matchAll(FOREIGN_ID) : []) {
      const raw = m[0]
      const id = raw.toLowerCase()
      if (OWN_PREFIX && id.startsWith(`${OWN_PREFIX}-`)) continue
      if (EXTENSION_AFTER.test(text.slice(m.index + raw.length))) continue
      if (NOT_IDS.some((n) => n.token === id)) continue
      if (isQuoted(bead.id, id)) continue
      failures.push(
        `${bead.id}: cites \`${raw}\`, an id from the predecessor repository's tracker.\n` +
          `    It does not resolve here -- \`bd show ${raw}\` errors -- so the fact it stands for does\n` +
          `    not travel with the bead. Copy the fact in and cite the in-repo file that carries it,\n` +
          `    or register the id in QUOTED_IDS in scripts/check-beads.mjs with a reason.`,
      )
    }

    // 2. Cross-repo beads cite their context bead.
    for (const [label, ctx] of Object.entries(CONTEXT_BEAD)) {
      if (closed) continue
      if (!labels.includes(label)) continue
      if (bead.id === ctx) continue
      if (text.includes(ctx)) continue
      failures.push(
        `${bead.id}: labelled \`${label}\` but does not cite \`${ctx}\`.\n` +
          `    That bead carries the rooted file map and the copied facts for this surface. Without\n` +
          `    it the reader has to open another checkout to find out what a bare basename means.`,
      )
    }

    // 3. An open bead a run filed discovered-from another names what its work would change.
    const from = (bead.dependencies ?? [])
      .filter((d) => d.type === 'discovered-from' && (d.issue_id ?? bead.id) === bead.id)
      .map((d) => d.depends_on_id)
    if (!closed && assetLabels && from.length > 0 && !labels.some((l) => assetLabels.has(l))) {
      const carried = labels.length ? labels.map((l) => `\`${l}\``).join(', ') : 'no label at all'
      failures.push(
        `${bead.id}: filed \`discovered-from\` ${from.join(', ')} and carries no label that \`${POLICY_KEY}\`\n` +
          `    in ${POLICY} lists (it carries ${carried}). Add one for each kind of file its work\n` +
          `    would change: without it \`bd count --by-label\` leaves the\n` +
          `    issue out and still reads as complete.`,
      )
    }

    // 4. An open bead's type is one a row of the rubric names.
    if (!closed && issueTypes && !issueTypes.has(bead.issue_type)) {
      const named = [...issueTypes].map((t) => `\`${t}\``).join(', ')
      failures.push(
        `${bead.id}: its type is \`${String(bead.issue_type)}\`, which no row of \`${TYPES_KEY}\` in ${POLICY}\n` +
          `    names (they name ${named}). Retype it to the first row that fits, \`bd update ${bead.id} -t <type>\`:\n` +
          `    a type no row describes is one no filer was told when to use.`,
      )
    }
  }

  // Consistency: the context beads this gate points people at must themselves exist.
  for (const [label, ctx] of Object.entries(CONTEXT_BEAD)) {
    if (!known.has(ctx)) {
      failures.push(
        `CONTEXT_BEAD maps ${label} to \`${ctx}\`, which is not in the export.\n` +
          `    This gate would send readers to an id as dead as the ones it forbids. Fix the mapping\n` +
          `    in scripts/check-beads.mjs.`,
      )
    }
  }

  return failures
}

/* --------------------------------------------------------------------------------- the gate ----- */

function main() {
  const loaded = loadBeads()

  if (loaded.kind === 'absent') {
    console.log(
      `beads:check -- skipped: \`bd\` is not installed here (${loaded.reason}).\n` +
        '  This gate reads the Dolt issue database, which a fresh clone and CI do not carry.\n',
    )
    process.exit(0)
  }

  if (loaded.kind === 'failed') {
    console.error(
      'beads:check FAILED -- the export did not happen:\n' +
        `  ${loaded.detail}\n\n` +
        '  A found `bd` is never reported as absent: the skip is for machines with no tracker, and\n' +
        '  this run had one, or was pointed at a copy. Fix the launcher, the tracker or the copy, then\n' +
        '  re-run.\n',
    )
    process.exit(1)
  }

  const { beads } = loaded
  const read = loadPolicy(ROOT)
  const assets = read.error ? {} : loadLabels(read.policy, POLICY_KEY, 3, 'what it covers')
  const types = read.error ? {} : loadIssueTypes(read.policy)
  const failures = [read.error, assets.error, types.error].filter(Boolean)
  failures.push(...runCheck(beads, assets.labels ?? null, types.types ?? null))

  if (failures.length) {
    console.error('beads:check FAILED\n')
    for (const f of failures) console.error(`  ${f}\n`)
    console.error(
      `${failures.length} problem(s) across ${beads.length} beads.\n` +
        'A bead is read by an agent long after its author is gone, and the tracker is all that\n' +
        'travels with it. Every identifier in it has to resolve from this checkout, and every label\n' +
        'a count reads has to be on it.\n',
    )
    process.exit(1)
  }

  console.log(
    `beads:check -- ${beads.length} beads: every identifier resolves here, every open bead filed\n` +
      `  discovered-from another carries a label \`${POLICY_KEY}\` lists,\n` +
      `  every open bead's type is one \`${TYPES_KEY}\` names, and every cross-repo bead cites its context bead.\n` +
      `  (read from ${loaded.through})\n`,
  )
}

/* --------------------------------------------------------------------------------- selftest ----- */

/**
 * The undoctored fixture: every exemption the rules make appears in it, so the control passing proves
 * none of them refuses. No bead carries a `repo:` label, so the control passing also proves an open
 * bead needs none. `asset` is a label and `type` a type the live policy lists, each read from it, so
 * the fixture spells no value either.
 */
function fixture(policy, asset, type) {
  const discoveredFrom = (id) => [
    { issue_id: id, depends_on_id: 'fx-parent', type: 'discovered-from', metadata: '{}' },
  ]
  return {
    policy,
    exportTail: '',
    writeExport: true,
    beads: [
      { _type: 'issue', id: 'fx-parent', status: 'open', issue_type: type, labels: [] },
      // Found, open, labelled: what rule 3 asks for.
      {
        _type: 'issue',
        id: 'fx-found',
        status: 'open',
        issue_type: type,
        labels: [asset],
        dependencies: discoveredFrom('fx-found'),
      },
      // Found, in progress, labelled: "open" is every status but closed.
      {
        _type: 'issue',
        id: 'fx-working',
        status: 'in_progress',
        issue_type: type,
        labels: [asset],
        dependencies: discoveredFrom('fx-working'),
      },
      // Found, closed, unlabelled, of a type no row names: exempt from rules 3 and 4, the count and
      // the rubric are read for what is still to do.
      {
        _type: 'issue',
        id: 'fx-closed',
        status: 'closed',
        issue_type: `${type}-retired`,
        labels: [],
        dependencies: discoveredFrom('fx-closed'),
      },
      // Not found: a child and a blocker carry no asset label and are not asked for one.
      {
        _type: 'issue',
        id: 'fx-child',
        status: 'open',
        issue_type: type,
        labels: [],
        dependencies: [
          { issue_id: 'fx-child', depends_on_id: 'fx-parent', type: 'parent-child', metadata: '{}' },
          { issue_id: 'fx-child', depends_on_id: 'fx-found', type: 'blocks', metadata: '{}' },
        ],
      },
    ],
  }
}

function beadOf(fx, id) {
  const bead = fx.beads.find((b) => b.id === id)
  if (!bead) throw new Error(`selftest fixture has no bead ${id}`)
  return bead
}

const without = (list, value) => list.filter((v) => v !== value)

function cases(asset, type) {
  const found = 'fx-found'
  const refusedFound = (id) =>
    new RegExp(`^  ${id}: filed \`discovered-from\` fx-parent and carries no label that \`${POLICY_KEY}\``, 'm')
  const refusedType = (id, carried) =>
    new RegExp(`^  ${id}: its type is \`${carried}\`, which no row of \`${TYPES_KEY}\``, 'm')
  const noTypes = new RegExp(`^  policy/vocabulary\\.json has no \`${TYPES_KEY}\` array whose every row names a \`type\``, 'm')
  return [
    {
      name: 'control: the undoctored fixture passes',
      doctor: () => {},
      expect: 'pass',
    },
    {
      name: 'an open issue filed discovered-from with no label the policy lists',
      doctor: (fx) => {
        beadOf(fx, found).labels = without(beadOf(fx, found).labels, asset)
      },
      expect: refusedFound(found),
    },
    {
      name: 'the same, in progress rather than open',
      doctor: (fx) => {
        beadOf(fx, 'fx-working').labels = without(beadOf(fx, 'fx-working').labels, asset)
      },
      expect: refusedFound('fx-working'),
    },
    {
      name: 'a label shaped like a listed one that the policy does not list',
      doctor: (fx) => {
        beadOf(fx, found).labels = beadOf(fx, found).labels.map((l) => (l === asset ? `${asset}-unlisted` : l))
      },
      expect: refusedFound(found),
    },
    {
      name: 'the policy renames the label the issue carries',
      doctor: (fx) => {
        const list = fx.policy[POLICY_KEY]
        list[`${asset}-renamed`] = list[asset]
        delete list[asset]
      },
      expect: refusedFound(found),
    },
    {
      name: `the policy has no ${POLICY_KEY}`,
      doctor: (fx) => {
        delete fx.policy[POLICY_KEY]
      },
      expect: new RegExp(`^  policy/vocabulary\\.json has no \`${POLICY_KEY}\` object with at least one label`, 'm'),
    },
    {
      name: `an open issue whose type no row of ${TYPES_KEY} names`,
      doctor: (fx) => {
        beadOf(fx, 'fx-child').issue_type = `${type}-unlisted`
      },
      expect: refusedType('fx-child', `${type}-unlisted`),
    },
    {
      name: `an in-progress issue whose type no row of ${TYPES_KEY} names`,
      doctor: (fx) => {
        beadOf(fx, 'fx-working').issue_type = `${type}-unlisted`
      },
      expect: refusedType('fx-working', `${type}-unlisted`),
    },
    {
      name: 'the policy renames the type the issues carry',
      doctor: (fx) => {
        const row = fx.policy[TYPES_KEY].find((r) => r.type === type)
        row.type = `${type}-renamed`
      },
      expect: refusedType(found, type),
    },
    {
      name: `the policy has no ${TYPES_KEY}`,
      doctor: (fx) => {
        delete fx.policy[TYPES_KEY]
      },
      expect: noTypes,
    },
    {
      name: `a row of ${TYPES_KEY} that names no type`,
      doctor: (fx) => {
        delete fx.policy[TYPES_KEY][0].type
      },
      expect: noTypes,
    },
    {
      name: `the override names a copy with no ${OVERRIDE_EXPORT}`,
      doctor: (fx) => {
        fx.writeExport = false
      },
      expect: new RegExp(`${ROOT_ENV} names .* which holds no ${OVERRIDE_EXPORT.replace('.', '\\.')}\\.`),
    },
    {
      name: 'an export line that is not JSON',
      doctor: (fx) => {
        fx.exportTail = 'not an issue\n'
      },
      expect: /export\.jsonl holds \d+ line\(s\) that do not parse as JSONL/,
    },
  ]
}

/** The fixture under `dir`: the committed records, each key of a doctored policy put back in its own, and the export. */
function writeFixture(dir, fx) {
  copyPolicy(REPO_ROOT, dir)
  if (!isDeepStrictEqual(fx.policy, readPolicy(dir))) {
    editPolicy(dir, (constants) => {
      for (const key of Object.keys(constants)) delete constants[key]
      Object.assign(constants, fx.policy)
    })
  }
  if (fx.writeExport) {
    const lines = fx.beads.map((b) => JSON.stringify(b)).join('\n')
    writeFileSync(join(dir, OVERRIDE_EXPORT), `${lines}\n${fx.exportTail}`)
  }
}

function selftest() {
  const committed = readPolicy(REPO_ROOT)
  const listed = Object.keys(committed?.[POLICY_KEY] ?? {}).sort(byCodePoint)
  if (listed.length === 0) {
    console.error(
      `beads selftest: the committed ${POLICY} lists no label under \`${POLICY_KEY}\`, so no fixture can ` +
        'carry one. `mise run beads:check` refuses that policy too.',
    )
    process.exit(1)
  }
  const asset = listed[0]
  const rows = committed?.[TYPES_KEY]
  const types = (Array.isArray(rows) ? rows.map((row) => row?.type).filter((t) => typeof t === 'string') : []).sort(
    byCodePoint,
  )
  if (types.length === 0) {
    console.error(
      `beads selftest: the committed ${POLICY} names no type under \`${TYPES_KEY}\`, so no fixture can ` +
        'carry one. `mise run beads:check` refuses that policy too.',
    )
    process.exit(1)
  }
  const type = types[0]

  const base = mkdtempSync(join(tmpdir(), 'check-beads-'))
  const results = []
  try {
    for (const { name, doctor, expect } of cases(asset, type)) {
      const fx = fixture(structuredClone(committed), asset, type)
      const before = JSON.stringify(fx)
      doctor(fx)
      if (expect !== 'pass' && JSON.stringify(fx) === before) {
        throw new Error(`selftest case "${name}" changed nothing -- the doctoring missed its target`)
      }
      const dir = join(base, name.replace(/[^a-z0-9]+/gi, '-'))
      writeFixture(dir, fx)
      const run = spawnSync(process.execPath, [SELF], {
        encoding: 'utf8',
        env: { ...process.env, [ROOT_ENV]: dir },
      })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      let ok
      let detail
      if (run.error) {
        ok = false
        detail = `the gate could not be started: ${run.error.message}`
      } else if (expect === 'pass') {
        const count = `-- ${fx.beads.length} beads:`
        ok = run.status === 0 && output.includes(count) && output.includes(`(${ROOT_ENV})`)
        detail = ok
          ? `passes, over the fixture's ${fx.beads.length} beads read through ${ROOT_ENV}`
          : run.status === 0
            ? `exited 0 without naming the fixture's bead count and ${ROOT_ENV}, so it did not read the fixture: ${output.trim()}`
            : `unexpected failure (exit ${String(run.status)}): ${output.trim()}`
      } else {
        ok = run.status === 1 && expect.test(output)
        detail = ok
          ? 'fails for that reason'
          : run.status === 0
            ? 'PASSED, but should have failed'
            : `failed (exit ${String(run.status)}), but not for that reason: ${output.trim()}`
      }
      results.push({ name, ok, detail })
      if (name.startsWith('control') && !ok) {
        console.error(`beads selftest: the undoctored fixture does not pass, so no case can be trusted: ${detail}`)
        process.exit(1)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  }
  console.log(
    `beads selftest: ${results.length - failed.length}/${results.length} cases hold` +
      ` (control plus ${results.length - 1} doctored copies).`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) selftest()
else main()

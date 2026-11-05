/**
 * policy.ts — the policy read whole: every record under `policy/`, its constants merged into one
 * object, for every tool, gate and prompt that reads a constant of the workflow.
 *
 * The records split the constants by who reads them and who may change them
 * (`policy/README.md`). A reader asks for a key, never for a
 * record, so a key can move between records without one of its readers changing. The headers each
 * record carries (`HEADER_FIELDS`) describe that record and are left out of the merge.
 *
 * THE FAILURE IT EXISTS TO PREVENT. No incident yet: the loader came with the split. Were it wrong,
 * a key defined in two records would reach each reader as whichever record it read last, and two
 * gates would hold one constant to two values while each passed. Or a reader would see a moved key
 * as absent, and fall back to a default or skip a refusal with no reason given. So it refuses a key
 * that two records define, and a record that is not a JSON object, rather than merging past either.
 * `mise run check:policy` holds the records' shape; this holds only what every reader needs to read
 * them at all.
 *
 * INVOCATION.
 *
 *   import { readPolicy } from '../tools/lib/policy.ts'
 *                                       readPolicy(root): the merged constants of the records under root
 *   node tools/lib/policy.ts <key>... [--prefix <p>]...
 *                                       prints the named constants, and every constant whose key starts
 *                                       with a prefix (no `Means`), as one JSON object in the merged
 *                                       order, for a prompt or a workflow's command; refuses a key no
 *                                       record holds. `check:policy:selftest` holds what it prints and
 *                                       refuses.
 *   POLICY_ROOT=<dir> node tools/lib/policy.ts ...
 *                                       the same over a doctored copy
 *
 * NEEDS. The committed records, or a `git` function to read them at a commit (`readPolicyAt`). No
 * network. Side-effect free on import.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the records live, relative to a repository root. */
export const POLICY_DIR = 'policy'

/** The fields that describe a record rather than hold a constant (`AGENTS.md` § Three kinds of file, and never a fourth). */
export const HEADER_FIELDS = ['describes', 'whyThisFileExists', 'gatedBy', 'whatItDoesNOTDo', 'provenance'] as const

export type Constants = Record<string, unknown>

/** One record: its repository-relative path and its parsed object, header included. */
export interface PolicyRecord {
  path: string
  data: Constants
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isRecord = (v: unknown): v is Constants => v !== null && typeof v === 'object' && !Array.isArray(v)
const isHeader = (key: string) => (HEADER_FIELDS as readonly string[]).includes(key)

/** A record's text parsed, or an error naming the record. */
export function parseRecord(path: string, text: string): PolicyRecord {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} does not parse as JSON: ${(error as Error).message}`)
  }
  if (!isRecord(data)) throw new Error(`${path} holds no JSON object`)
  return { path, data }
}

/** Every record's constants in one object, records in code-point order of path; refuses a key two define. */
export function mergeRecords(records: PolicyRecord[]): Constants {
  if (records.length === 0) throw new Error(`no policy record: ${POLICY_DIR}/ holds no .json file`)
  const merged: Constants = {}
  const home = new Map<string, string>()
  for (const { path, data } of [...records].sort((a, b) => byCodePoint(a.path, b.path))) {
    for (const [key, value] of Object.entries(data)) {
      if (isHeader(key)) continue
      const first = home.get(key)
      if (first !== undefined) throw new Error(`\`${key}\` is defined in both ${first} and ${path}: a constant has one home`)
      home.set(key, path)
      merged[key] = value
    }
  }
  return merged
}

/** The repository-relative path of every record under `root`, in code-point order. */
export function recordPaths(root: string): string[] {
  const dir = join(root, POLICY_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort(byCodePoint)
    .map((name) => `${POLICY_DIR}/${name}`)
}

/** Every record under `root`, parsed. */
export function readRecords(root: string): PolicyRecord[] {
  return recordPaths(root).map((path) => parseRecord(path, readFileSync(join(root, path), 'utf8')))
}

/** The merged constants of the records under `root`. Throws, naming the record, when one cannot be read. */
export function readPolicy(root: string): Constants {
  return mergeRecords(readRecords(root))
}

/** The merged constants as commit `rev` has them, read through `git` (as `gitIn` in `git-env.ts` returns it). */
export function readPolicyAt(git: (args: string[]) => string, rev: string): Constants {
  const paths = git(['ls-tree', '--name-only', `${rev}:${POLICY_DIR}`])
    .split('\n')
    .filter((name) => name.endsWith('.json'))
    .sort(byCodePoint)
    .map((name) => `${POLICY_DIR}/${name}`)
  return mergeRecords(paths.map((path) => parseRecord(path, git(['show', `${rev}:${path}`]))))
}

/** Copy every record from the tree at `from` into the tree at `to`, for a fixture. */
export function copyPolicy(from: string, to: string): void {
  mkdirSync(join(to, POLICY_DIR), { recursive: true })
  for (const path of recordPaths(from)) copyFileSync(join(from, path), join(to, path))
}

/**
 * Doctor the records under `root` for a fixture: `change` edits the merged constants in place, and
 * each key goes back to the record that held it. A key `change` adds goes to the record of the key
 * it is the `Means` of, or else to `newKeysIn`; a key it deletes leaves its record. A change that
 * alters nothing is a broken fixture, and refused.
 */
export function editPolicy(root: string, change: (constants: Constants) => void, newKeysIn?: string): void {
  const records = readRecords(root)
  const merged = mergeRecords(records)
  const before = JSON.stringify(merged)
  change(merged)
  if (JSON.stringify(merged) === before) throw new Error(`a fixture's edit of ${POLICY_DIR}/ under ${root} changed nothing`)
  const held = new Set<string>()
  for (const record of records) {
    for (const key of Object.keys(record.data)) {
      if (isHeader(key)) continue
      held.add(key)
      if (Object.hasOwn(merged, key)) record.data[key] = merged[key]
      else delete record.data[key]
    }
  }
  for (const key of Object.keys(merged).filter((k) => !held.has(k))) {
    const base = key.endsWith('Means') ? key.slice(0, -'Means'.length) : null
    const target = records.find((r) => base !== null && Object.hasOwn(r.data, base))?.path ?? newKeysIn
    if (target === undefined) throw new Error(`a fixture added \`${key}\` with no record to put it in: name one as newKeysIn`)
    let record = records.find((r) => r.path === target)
    if (!record) {
      record = { path: target, data: {} }
      records.push(record)
    }
    record.data[key] = merged[key]
  }
  for (const { path, data } of records) writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`)
}

/* ------------------------------------------------------------------------------------ the CLI ----- */

function main(argv: string[]): number {
  const root = resolve(process.env.POLICY_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../..'))
  const keys: string[] = []
  const prefixes: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prefix') {
      const prefix = argv[++i]
      if (!prefix) {
        console.error('policy: --prefix needs a value')
        return 2
      }
      prefixes.push(prefix)
    } else keys.push(argv[i])
  }
  if (keys.length === 0 && prefixes.length === 0) {
    console.error('policy: name at least one key or --prefix; usage: node tools/lib/policy.ts <key>... [--prefix <p>]...')
    return 2
  }
  let policy: Constants
  try {
    policy = readPolicy(root)
  } catch (error) {
    console.error(`policy: ${(error as Error).message}`)
    return 1
  }
  const missing = keys.filter((key) => !Object.hasOwn(policy, key))
  if (missing.length) {
    console.error(`policy: no record under ${POLICY_DIR}/ holds ${missing.map((k) => `\`${k}\``).join(', ')}`)
    return 1
  }
  const chosen: Constants = {}
  for (const [key, value] of Object.entries(policy)) {
    const byPrefix = prefixes.some((p) => key.startsWith(p)) && !key.endsWith('Means')
    if (keys.includes(key) || byPrefix) chosen[key] = value
  }
  console.log(JSON.stringify(chosen))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))

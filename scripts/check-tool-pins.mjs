/**
 * Tool-pin advisory gate. It reads each tool version the repository pins outside a lockfile
 * osv-scanner reads: every `[tools]` entry of `mise.toml`, every `[[tools.<name>]]` entry of
 * `mise.lock`, and the `packageManager` field of every tracked `package.json`. It maps each mise tool
 * to the osv.dev package its row in `toolPinOsvPackages` (`policy/tool-pins.json`) names, and a
 * `packageManager` to the npm package of the name it gives. Then it asks osv.dev's batch query
 * endpoint for the advisories against each version, and refuses every pinned version that has one.
 * A pin whose row says `unchecked`, because osv.dev covers no ecosystem the tool is published in, is
 * printed as unchecked on every run, and is never passed in silence. A repository that pins no tool
 * skips clean, and says so.
 *
 * It also refuses a mise pin with no row, a row that names no pin, and a row it cannot read. So a
 * tool pinned with no decision about where osv.dev files it fails, instead of passing unchecked. An
 * advisory that does not apply is accepted in its row's `accepted`, with an `until` date after which
 * it fails the gate again.
 *
 * It reads the working tree's copy of each file, as every gate here does. A new advisory can land
 * against a pin nobody changed. The pre-push job runs only when a file it reads changes, so it misses
 * that advisory; the CI step runs on every pull request, and finds it.
 *
 * THE FAILURE IT EXISTS TO PREVENT. `deps:check` hands osv-scanner the tracked lockfiles, and
 * osv-scanner reads neither `mise.lock` nor `packageManager`, so no gate saw an advisory against a
 * pinned tool. On 2026-11-08 ss-vbd found by hand that pnpm 11.1.2, the version the product came
 * with, had 17 advisories on osv.dev, which every gate had passed (ss-8e9). The first attempt at this
 * gate, the same day, fed osv-scanner 2.6.0 the pins as a lockfile in its own `osv-scanner:` format.
 * That found pnpm's advisories, but it matched none in the Bitnami ecosystem, where osv.dev files
 * Node.js's own: it reported node 20.0.0 clean where osv.dev's API listed 81, and node 24.21.0, the
 * pin that day, clean where the API listed 8, one of them Critical. So this gate asks the API
 * itself, and its first run refused node 24.21.0 (ss-wnk). Were it wrong, a pinned tool with a
 * published advisory would merge unnoticed: every push would pass if it read an unreachable osv.dev
 * as nothing found, and every new tool would pass if a pin with no row counted as unchecked.
 *
 * INVOCATION.
 *
 *   mise run deps:tools:check                           every pin, against osv.dev
 *   mise run deps:tools:selftest                        (--selftest) each refusal and the skip,
 *                                                       offline, over scratch repositories and a
 *                                                       stub of osv.dev on loopback
 *   TOOL_PINS_CHECK_ROOT=<dir> mise run deps:tools:check
 *                                                       the same gate over a doctored copy
 *   TOOL_PINS_OSV_API_URL=<url>                         another osv.dev than https://api.osv.dev,
 *                                                       the selftest's stub
 *
 * NEEDS Git, to list the tracked `package.json` files; `smol-toml`, which `package.json` pins, to read
 * the TOML; and the network: osv.dev's API, which an unreachable osv.dev or one that does not answer
 * within `QUERY_TIMEOUT_MS` fails, as any failure of a tool that was found does. Its selftest needs
 * no network. 0.45 s wall for the gate over 7 mise pins and 1 `packageManager`, and 3.02 s for its 28
 * cases, through `mise run` (`/usr/bin/time -p`, one run each) on a macOS laptop, 2026-11-08.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { gitIn, SCRATCH_GIT_ENV } from '../tools/lib/git-env.ts'
import { readPolicy } from '../tools/lib/policy.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.TOOL_PINS_CHECK_ROOT ? resolve(process.env.TOOL_PINS_CHECK_ROOT) : REPO_ROOT
const API = (process.env.TOOL_PINS_OSV_API_URL || 'https://api.osv.dev').replace(/\/+$/, '')
const TABLE = 'toolPinOsvPackages'
const RECORD = 'policy/tool-pins.json'
// How long the one query to osv.dev may take before the gate fails, instead of holding a push.
const QUERY_TIMEOUT_MS = 30_000
// corepack's form: `<name>@<version>`, with an optional `+<hash>` the version stops before.
const PACKAGE_MANAGER = /^((?:@[^@/]+\/)?[^@]+)@([^+]+)(?:\+.+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 200)

/** `name` under `root` parsed as TOML, or `null` when it is absent or, with a problem, cannot be read. */
function readToml(root, name, problems) {
  const path = join(root, name)
  if (!existsSync(path)) return null
  try {
    return parseToml(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`${name} cannot be read as TOML, so its pins are unknown: ${oneLine(error.message)}`)
    return null
  }
}

/** Every pin under `root`: `{ tool, version, source, packageManager }`, in file order. */
function readPins(root, problems) {
  const pins = []
  const pin = (tool, value, source) => {
    if (isText(value)) pins.push({ tool, version: value, source, packageManager: false })
    else problems.push(`${source} pins ${tool} as ${JSON.stringify(value)}, not a version string, so the version to check is unknown`)
  }
  const config = readToml(root, 'mise.toml', problems)
  for (const [tool, value] of Object.entries(isObject(config?.tools) ? config.tools : {})) pin(tool, value, 'mise.toml')
  const lock = readToml(root, 'mise.lock', problems)
  for (const [tool, entries] of Object.entries(isObject(lock?.tools) ? lock.tools : {})) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) pin(tool, entry?.version, 'mise.lock')
  }
  let files = []
  try {
    files = gitIn(root)(['ls-files', '-z']).split('\0')
  } catch (error) {
    problems.push(`the tracked files under ${root} are unknown, so no packageManager could be read: ${oneLine(error.message)}`)
  }
  for (const file of files.filter((f) => f === 'package.json' || f.endsWith('/package.json')).sort(byCodePoint)) {
    if (!existsSync(join(root, file))) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(root, file), 'utf8'))
    } catch (error) {
      problems.push(`${file} cannot be read as JSON, so its packageManager is unknown: ${oneLine(error.message)}`)
      continue
    }
    if (manifest?.packageManager === undefined) continue
    const match = typeof manifest.packageManager === 'string' ? PACKAGE_MANAGER.exec(manifest.packageManager) : null
    if (match) pins.push({ tool: match[1], version: match[2], source: `${file} packageManager`, packageManager: true })
    else problems.push(`${file} names ${JSON.stringify(manifest.packageManager)} as its packageManager, not \`<name>@<version>\`, so the version to check is unknown`)
  }
  return pins
}

/** The table of rows under `root`'s policy, or `{}` with a problem when it cannot be read. */
function readTable(root, problems) {
  let policy
  try {
    policy = readPolicy(root)
  } catch (error) {
    problems.push(`the policy under ${root} cannot be read, so no pin can be mapped: ${oneLine(error.message)}`)
    return {}
  }
  if (policy[TABLE] === undefined) return {}
  if (isObject(policy[TABLE])) return policy[TABLE]
  problems.push(`${TABLE} in ${RECORD} is not a table keyed by tool, so no pin can be mapped`)
  return {}
}

/** Why the row for `tool` cannot be read, or `null`. */
function rowProblem(tool, row) {
  const at = `${TABLE}.${tool}`
  const mapped = isObject(row) && isText(row.ecosystem) && isText(row.package)
  const unchecked = isObject(row) && row.unchecked === true
  if (mapped === unchecked) return `${at} names no osv.dev ecosystem and package, or names them beside \`unchecked\`: a row is one or the other`
  if (!isText(row.means)) return `${at} has no \`means\` saying why it maps the tool as it does`
  for (const [id, acceptance] of Object.entries(row.accepted ?? {})) {
    if (!DATE.test(acceptance?.until ?? '') || !isText(acceptance?.reason)) return `${at} accepts ${id} with no \`until\` date (YYYY-MM-DD) and \`reason\``
  }
  return null
}

/** osv.dev's results for `queries`, one per query in order, or the problem that kept them back. */
async function ask(api, queries) {
  const url = `${api}/v1/querybatch`
  let response
  let text
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: queries.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version })) }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    })
    text = await response.text()
  } catch (error) {
    return { problem: `osv.dev could not be reached at ${api} (${oneLine(error.cause?.code ?? error.cause?.message ?? error.message)}), so the pins were not checked` }
  }
  if (!response.ok) return { problem: `osv.dev answered ${response.status} at ${url}, so the pins were not checked: ${oneLine(text)}` }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { problem: `osv.dev's answer at ${url} is not JSON, so the pins were not checked: ${oneLine(text)}` }
  }
  const results = body?.results
  const shaped =
    Array.isArray(results) &&
    results.length === queries.length &&
    results.every((r) => isObject(r) && (r.vulns === undefined || (Array.isArray(r.vulns) && r.vulns.every((v) => isText(v?.id)))))
  if (!shaped) return { problem: `osv.dev's answer is not one result per query, each a list of advisory ids, so which pin each answers is unknown: ${oneLine(text)}` }
  return { results }
}

/**
 * What osv.dev holds against the pins under `root`: `pass`, `skip` or `fail`, with the lines that say
 * why, and the pins left unchecked.
 */
async function runCheck(root, { api = API } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const problems = []
  const pins = readPins(root, problems)
  // Before the table is read, since the policy loader refuses a tree with no record at all.
  if (pins.length === 0 && problems.length === 0) {
    return { status: 'skip', lines: ['no mise.toml, mise.lock or packageManager pins a tool, so nothing to check'], unchecked: [] }
  }
  const table = readTable(root, problems)
  const miseTools = new Set(pins.filter((p) => !p.packageManager).map((p) => p.tool))
  const rows = new Map()
  const unreadable = new Set()
  for (const tool of Object.keys(table).sort(byCodePoint)) {
    const problem = rowProblem(tool, table[tool])
    if (problem) {
      problems.push(problem)
      unreadable.add(tool)
    } else if (!miseTools.has(tool)) {
      problems.push(`${TABLE} names \`${tool}\`, which neither mise.toml nor mise.lock pins: its row goes with its pin`)
    } else {
      rows.set(tool, table[tool])
    }
  }
  const queries = new Map()
  const unchecked = new Map()
  const unmapped = new Map()
  const add = (map, key, item) => map.set(key, [...(map.get(key) ?? []), item])
  for (const pin of pins) {
    const row = pin.packageManager ? { ecosystem: 'npm', package: pin.tool } : rows.get(pin.tool)
    if (row === undefined) {
      if (!unreadable.has(pin.tool)) add(unmapped, pin.tool, `${pin.source} ${pin.version}`)
      continue
    }
    if (row.unchecked) {
      add(unchecked, `${pin.tool} ${pin.version}`, pin.source)
      continue
    }
    const key = `${row.ecosystem}\0${row.package}\0${pin.version}`
    const query = queries.get(key) ?? { ecosystem: row.ecosystem, name: row.package, version: pin.version, sources: [] }
    query.sources.push(pin.packageManager ? pin.source : `${pin.source} ${pin.tool}`)
    queries.set(key, query)
  }
  for (const tool of [...unmapped.keys()].sort(byCodePoint)) {
    problems.push(
      `${tool} (${unmapped.get(tool).join(', ')}) has no row in ${TABLE} (${RECORD}): add the osv.dev ecosystem and package it is published as, or \`unchecked: true\`, with the reason in \`means\``,
    )
  }
  const accepted = new Map()
  for (const row of rows.values()) {
    if (row.accepted) accepted.set(`${row.ecosystem}\0${row.package}`, { ...accepted.get(`${row.ecosystem}\0${row.package}`), ...row.accepted })
  }
  const findings = []
  const list = [...queries.values()]
  if (list.length > 0) {
    const { problem, results } = await ask(api, list)
    if (problem) problems.push(problem)
    else {
      list.forEach((query, i) => {
        const label = `${query.ecosystem} ${query.name}@${query.version} (${query.sources.join(', ')})`
        if (results[i].next_page_token !== undefined) {
          findings.push(`${label}: osv.dev holds more advisories than one page answers, so they cannot all be named; move the pin`)
          return
        }
        const acceptances = accepted.get(`${query.ecosystem}\0${query.name}`) ?? {}
        const open = []
        for (const { id } of results[i].vulns ?? []) {
          const acceptance = acceptances[id]
          if (acceptance && acceptance.until >= today) continue
          open.push(acceptance ? `${id}, whose acceptance ended ${acceptance.until}` : id)
        }
        if (open.length > 0) findings.push(`${label}: ${open.sort(byCodePoint).join(', ')}`)
      })
    }
  }
  const uncheckedLines = [...unchecked.keys()]
    .sort(byCodePoint)
    .map((pin) => `${pin} (${unchecked.get(pin).join(', ')}), whose row says osv.dev covers no ecosystem it is published in`)
  if (problems.length > 0 || findings.length > 0) return { status: 'fail', lines: [...problems, ...findings.sort(byCodePoint)], unchecked: uncheckedLines }
  return { status: 'pass', lines: [`${list.length} package version(s) asked of osv.dev, and no known advisory`], unchecked: uncheckedLines }
}

async function main() {
  const { status, lines, unchecked } = await runCheck(ROOT)
  for (const line of unchecked) console.log(`deps:tools: unchecked, ${line}.`)
  if (status === 'fail') {
    console.error(`deps:tools: refused, ${lines.length} problem(s).\n`)
    for (const line of lines) console.error(`  - ${line}`)
    console.error(
      `\nMove each pin to a version osv.dev lists no advisory against, or accept an advisory that does not apply in its row's \`accepted\` in ${RECORD}, with an \`until\` date and a \`reason\`.`,
    )
    process.exit(1)
  }
  console.log(`deps:tools: ${status === 'skip' ? 'skipped, ' : ''}${lines[0]}.`)
}

/* --------------------------------------------------------------------------------- selftest ----- */

/** The fixture advisory database the stub of osv.dev answers from: each advisory against exact versions. */
const ADVISORIES = [
  { id: 'FIX-NODE-1', ecosystem: 'Bitnami', name: 'node', versions: ['1.0.0'] },
  { id: 'FIX-PNPM-1', ecosystem: 'npm', name: 'pnpm', versions: ['1.0.0', '2.0.0'] },
  { id: 'FIX-GO-1', ecosystem: 'Go', name: 'example.com/fixture/tool', versions: ['1.0.0'] },
]

/** A stub of osv.dev's batch endpoint on loopback. `state.mode` makes it misbehave; `state.asked` is the last request's queries. */
async function stub() {
  const state = { mode: 'ok', asked: [] }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/querybatch') {
        res.writeHead(404)
        return res.end('not found')
      }
      const { queries } = JSON.parse(body)
      state.asked = queries.map((q) => `${q.package.ecosystem} ${q.package.name} ${q.version}`).sort(byCodePoint)
      const results = queries.map((q) => {
        const vulns = ADVISORIES.filter((a) => a.ecosystem === q.package.ecosystem && a.name === q.package.name && a.versions.includes(q.version))
        return vulns.length > 0 ? { vulns: vulns.map(({ id }) => ({ id, modified: '2026-11-08T00:00:00Z' })) } : {}
      })
      if (state.mode === 'status') {
        res.writeHead(503)
        return res.end('a fixture outage')
      }
      if (state.mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<html>a fixture page</html>')
      }
      if (state.mode === 'short') results.pop()
      if (state.mode === 'paged') results[0] = { ...results[0], next_page_token: 'a-fixture-page' }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((done) => server.close(done)) }
}

/** A loopback address nothing listens on. */
async function closedUrl() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return `http://127.0.0.1:${port}`
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const tomlKey = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))
const ROWS = {
  node: { ecosystem: 'Bitnami', package: 'node', means: 'a fixture row' },
  'npm:pnpm': { ecosystem: 'npm', package: 'pnpm', means: 'a fixture row' },
  'github:fixture/tool': { ecosystem: 'Go', package: 'example.com/fixture/tool', means: 'a fixture row' },
  'fixture-unchecked': { unchecked: true, means: 'a fixture tool no ecosystem covers' },
}
const TOOLS = Object.keys(ROWS)
const acceptNode = (acceptance) => ({ node: { ...ROWS.node, accepted: { 'FIX-NODE-1': acceptance } } })

/** The files of a case: the undoctored fixture with `tools` (TOML values), `locked`, `packageManager`, `rows`, `table` and `files` laid over it. */
function caseFiles(c) {
  if (c.only) return c.only
  const tools = { ...Object.fromEntries(TOOLS.map((tool) => [tool, '"1.0.1"'])), ...c.tools }
  const locked = { ...Object.fromEntries(TOOLS.map((tool) => [tool, '1.0.1'])), ...c.locked }
  return {
    'mise.toml': `[tools]\n${Object.entries(tools).map(([tool, value]) => `${tomlKey(tool)} = ${value}\n`).join('')}`,
    'mise.lock': `lockfile_version = 3\n${Object.entries(locked).map(([tool, version]) => `\n[[tools.${tomlKey(tool)}]]\nversion = "${version}"\nbackend = "fixture:${tool}"\n`).join('')}`,
    'package.json': json({ name: 'fixture', private: true }),
    'src/package.json': json({ name: 'fixture-src', private: true, packageManager: c.packageManager ?? 'pnpm@1.0.1' }),
    'policy/tool-pins.json': json({ [TABLE]: c.table ?? { ...ROWS, ...c.rows } }),
    ...c.files,
  }
}

const CLEAN = /^3 package version\(s\) asked of osv\.dev, and no known advisory$/

function cases(closed) {
  return [
    {
      name: 'control: every pin clean, and one unchecked',
      expect: CLEAN,
      asked: ['Bitnami node 1.0.1', 'Go example.com/fixture/tool 1.0.1', 'npm pnpm 1.0.1'],
      unchecked: /^fixture-unchecked 1\.0\.1 \(mise\.toml, mise\.lock\), whose row says osv\.dev covers no ecosystem it is published in$/,
    },
    { name: 'a vulnerable version in mise.toml', tools: { node: '"1.0.0"' }, refuse: /^Bitnami node@1\.0\.0 \(mise\.toml node\): FIX-NODE-1$/ },
    { name: 'a vulnerable version in mise.lock', locked: { 'github:fixture/tool': '1.0.0' }, refuse: /^Go example\.com\/fixture\/tool@1\.0\.0 \(mise\.lock github:fixture\/tool\): FIX-GO-1$/ },
    { name: "a vulnerable packageManager, with corepack's hash", packageManager: 'pnpm@2.0.0+sha512.fixture', refuse: /^npm pnpm@2\.0\.0 \(src\/package\.json packageManager\): FIX-PNPM-1$/ },
    { name: 'an untracked package.json is not read', untracked: { 'stray/package.json': json({ packageManager: 'pnpm@2.0.0' }) }, expect: CLEAN },
    { name: 'a packageManager with no version', packageManager: 'pnpm', refuse: /^src\/package\.json names "pnpm" as its packageManager, not `<name>@<version>`/ },
    { name: 'a package.json that is not JSON', files: { 'src/package.json': '{\n' }, refuse: /^src\/package\.json cannot be read as JSON/ },
    { name: 'a pin that is not a version string', tools: { node: '{ version = "1.0.1" }' }, refuse: /^mise\.toml pins node as \{"version":"1\.0\.1"\}, not a version string/ },
    { name: 'a mise.toml that is not TOML', files: { 'mise.toml': '[tools\n' }, refuse: /^mise\.toml cannot be read as TOML/ },
    { name: 'a pin with no row', tools: { extra: '"1.0.1"' }, locked: { extra: '1.0.1' }, refuse: /^extra \(mise\.toml 1\.0\.1, mise\.lock 1\.0\.1\) has no row in toolPinOsvPackages/ },
    { name: 'a row that names no pin', rows: { gone: { unchecked: true, means: 'a fixture row' } }, refuse: /^toolPinOsvPackages names `gone`, which neither mise\.toml nor mise\.lock pins/ },
    { name: 'a row with neither a package nor unchecked', rows: { node: { ecosystem: 'Bitnami', means: 'a fixture row' } }, refuse: /^toolPinOsvPackages\.node names no osv\.dev ecosystem and package/ },
    { name: 'a row with no means', rows: { node: { ecosystem: 'Bitnami', package: 'node' } }, refuse: /^toolPinOsvPackages\.node has no `means`/ },
    { name: 'a table that is not keyed by tool', table: ['node'], refuse: /^toolPinOsvPackages in policy\/tool-pins\.json is not a table keyed by tool/ },
    { name: 'a policy that cannot be read', files: { 'policy/tool-pins.json': '{\n' }, refuse: /^the policy under .+ cannot be read, so no pin can be mapped/ },
    {
      name: 'an accepted advisory passes until its date',
      tools: { node: '"1.0.0"' },
      locked: { node: '1.0.0' },
      rows: acceptNode({ until: '2999-12-31', reason: 'a fixture acceptance' }),
      expect: CLEAN,
    },
    {
      name: 'an acceptance whose date has passed',
      tools: { node: '"1.0.0"' },
      locked: { node: '1.0.0' },
      rows: acceptNode({ until: '2000-01-01', reason: 'a fixture acceptance' }),
      refuse: /^Bitnami node@1\.0\.0 \(mise\.toml node, mise\.lock node\): FIX-NODE-1, whose acceptance ended 2000-01-01$/,
    },
    { name: 'an acceptance with no reason', rows: acceptNode({ until: '2999-12-31' }), refuse: /^toolPinOsvPackages\.node accepts FIX-NODE-1 with no `until` date/ },
    { name: 'an acceptance whose until is not a date', rows: acceptNode({ until: 'soon', reason: 'a fixture acceptance' }), refuse: /^toolPinOsvPackages\.node accepts FIX-NODE-1 with no `until` date/ },
    { name: 'no pin skips clean, and says so', only: { 'README.md': '# fixture\n' }, skip: /^no mise\.toml, mise\.lock or packageManager pins a tool, so nothing to check$/ },
    { name: 'a root that is not a repository', bare: true, refuse: /^the tracked files under .+ are unknown, so no packageManager could be read/ },
    { name: 'an unreachable osv.dev fails, and is no skip', api: closed, refuse: /^osv\.dev could not be reached at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/ },
    { name: 'osv.dev answering an error', mode: 'status', refuse: /^osv\.dev answered 503 at http:\/\/127\.0\.0\.1:\d+\/v1\/querybatch/ },
    { name: 'osv.dev answering what is not JSON', mode: 'garbage', refuse: /^osv\.dev's answer at http:\/\/127\.0\.0\.1:\d+\/v1\/querybatch is not JSON/ },
    { name: 'osv.dev answering too few results', mode: 'short', refuse: /^osv\.dev's answer is not one result per query/ },
    { name: 'osv.dev holding more advisories than one page', mode: 'paged', refuse: /^Bitnami node@1\.0\.1 \(mise\.toml node, mise\.lock node\): osv\.dev holds more advisories than one page answers/ },
  ]
}

const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-')

function fixture(base, c) {
  const dir = join(base, slug(c.name))
  const put = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  mkdirSync(dir, { recursive: true })
  const tracked = caseFiles(c)
  put(tracked)
  if (!c.bare) {
    const git = gitIn(dir, SCRATCH_GIT_ENV)
    git(['init', '-q', '-b', 'main'])
    git(['add', '--', ...Object.keys(tracked)])
  }
  put(c.untracked ?? {})
  return dir
}

/** Run this gate as a hook and CI do, without blocking the stub it talks to. */
function runGate(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SELF], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

async function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'check-tool-pins-'))
  const osv = await stub()
  const results = []
  try {
    const all = cases(await closedUrl())
    const dirs = new Map()
    for (const c of all) {
      const dir = fixture(base, c)
      dirs.set(c.name, dir)
      osv.state.mode = c.mode ?? 'ok'
      osv.state.asked = []
      const { status, lines, unchecked } = await runCheck(dir, { api: c.api ?? osv.url })
      const said = lines.join(' | ')
      const [want, reason] = c.refuse ? ['fail', c.refuse] : c.skip ? ['skip', c.skip] : ['pass', c.expect]
      let problem = null
      if (status !== want) problem = `${status}, not ${want}: ${said}`
      else if (!lines.some((line) => reason.test(line))) problem = `${status}, but not for that reason: ${said}`
      else if (c.asked && JSON.stringify(osv.state.asked) !== JSON.stringify(c.asked)) problem = `asked osv.dev for ${JSON.stringify(osv.state.asked)}, not ${JSON.stringify(c.asked)}`
      else if (c.unchecked && !unchecked.some((line) => c.unchecked.test(line))) problem = `named ${JSON.stringify(unchecked)} as unchecked`
      results.push({ name: c.name, ok: problem === null, detail: problem ?? `${{ pass: 'passes', skip: 'skips', fail: 'fails' }[status]} for that reason` })
      if (c.name.startsWith('control') && problem) {
        console.error(`selftest: the undoctored fixture does not pass, so no case can be trusted: ${problem}`)
        process.exit(1)
      }
    }
    // The gate end to end through its root override, so the exit and the lines a hook and CI read are
    // held too: the control passes and names its unchecked pin, and a vulnerable pin exits 1.
    osv.state.mode = 'ok'
    const control = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: osv.url })
    const passes =
      control.status === 0 &&
      /^deps:tools: unchecked, fixture-unchecked 1\.0\.1 \(mise\.toml, mise\.lock\)/m.test(control.stdout) &&
      /^deps:tools: 3 package version\(s\) asked of osv\.dev, and no known advisory\.$/m.test(control.stdout)
    results.push({ name: 'TOOL_PINS_CHECK_ROOT points the gate at a passing copy', ok: passes, detail: passes ? 'exits 0, and names the unchecked pin' : `exited ${control.status}: ${control.stdout}${control.stderr}` })
    const vulnerable = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get('a vulnerable version in mise.toml'), TOOL_PINS_OSV_API_URL: osv.url })
    const refuses = vulnerable.status === 1 && /^ {2}- Bitnami node@1\.0\.0 \(mise\.toml node\): FIX-NODE-1$/m.test(vulnerable.stderr)
    results.push({ name: 'TOOL_PINS_CHECK_ROOT points the gate at a refused copy', ok: refuses, detail: refuses ? 'exits 1, and names the advisory' : `exited ${vulnerable.status}: ${vulnerable.stdout}${vulnerable.stderr}` })
  } finally {
    await osv.close()
    rmSync(base, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  console.log(`deps:tools selftest: ${results.length - failed.length}/${results.length} cases hold.`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) await selftest()
else await main()

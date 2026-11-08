/**
 * Tool-pin advisory gate. It reads each tool version the repository pins outside a lockfile
 * osv-scanner reads: every `[tools]` entry of `mise.toml`, every `[[tools.<name>]]` entry of
 * `mise.lock`, and the `packageManager` field of every tracked `package.json`. It maps each mise tool
 * to the osv.dev packages its row in `toolPinOsvPackages` (`policy/tool-pins.json`) names, and each
 * `packageManager` to those its row in `packageManagerOsvPackages` names. Then it asks osv.dev's
 * batch query endpoint for the advisories against each version, and refuses every pinned version that
 * has one. A pin whose row says `unchecked`, because osv.dev covers no ecosystem the tool is published
 * in, is printed as unchecked on every run, and never passed in silence. A repository that pins no
 * tool skips clean, and says so.
 *
 * It also refuses a mise pin or a `packageManager` with no row, a row in `toolPinOsvPackages` that
 * names no pin, and a row it cannot read. So a tool pinned with no decision about where osv.dev files
 * it fails, instead of passing unchecked; the operator chose on 2026-11-08 that a `packageManager` is
 * held to that as a mise pin is (ss-8e9). It refuses a Go package whose `/vN` suffix does not match
 * the pin's major version, because Go names each major version from 2 up as its own module, and
 * osv.dev answers nothing for a version the module path cannot hold. An advisory that does not apply
 * is accepted in its row's `accepted`, with an `until` date after which it fails the gate again.
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
 * itself, and its first run refused node 24.21.0 (ss-wnk). Its review the same day found four of its
 * checks held by no case, a Go major-version bump passing in silence, and a Yarn 2 `packageManager`
 * checked as the npm package `yarn`, which Yarn 2 and later do not publish as. To honour a proxy, the
 * gate first started itself again with `--use-env-proxy`; the reviews then had to guard that re-start
 * against a loop, and a third review found the guard's process-group kill could miss a process
 * mid-fork, so that 2 of 6 selftest runs hung and one chain passed 1000 processes in 120 s. So the
 * task now starts the gate with the flag, and nothing starts again. Were it wrong, a pinned tool with
 * a published advisory would merge unnoticed: every push would pass if it read an unreachable
 * osv.dev as nothing found, and every new tool would pass if a pin with no row counted as unchecked.
 *
 * INVOCATION.
 *
 *   mise run deps:tools:check                           every pin, against osv.dev, as
 *                                                       `node --use-env-proxy scripts/check-tool-pins.mjs`
 *   mise run deps:tools:selftest                        (--selftest) each refusal and the skip,
 *                                                       offline, over scratch repositories and a
 *                                                       stub of osv.dev on loopback; with no flag
 *   TOOL_PINS_CHECK_ROOT=<dir> mise run deps:tools:check
 *                                                       the same gate over a doctored copy
 *   TOOL_PINS_OSV_API_URL=<url>                         another osv.dev than https://api.osv.dev,
 *                                                       the selftest's stub
 *
 * NEEDS Git, to list the tracked `package.json` files; `smol-toml`, which `package.json` pins, to read
 * the TOML; and the network: osv.dev's API, which an unreachable osv.dev or one that does not answer
 * within `toolPinQueryTimeoutSeconds` fails, as any failure of a tool that was found does. Behind a
 * proxy it honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, as Node reads them. That differs from
 * osv-scanner in one case: with `HTTP_PROXY` set and `HTTPS_PROXY` not, Node sends osv.dev's https
 * request through `HTTP_PROXY`, while osv-scanner, a Go program, sends it direct (`deps:check` passed
 * with `HTTP_PROXY` alone naming a closed port, 2026-11-08). Node's `fetch` reads the variables only
 * when Node starts with `--use-env-proxy` or `NODE_USE_ENV_PROXY=1`, and setting either from inside
 * the process is too late (Node 24.22.1, 2026-11-08). So the task passes the flag. A run by hand with
 * a proxy variable set and neither says so on stderr and goes on direct, which fails closed where
 * osv.dev is reachable only through the proxy. Loopback goes direct whatever the proxy, because the
 * gate and its selftest add it to `NO_PROXY`, which Node reads per request. Its selftest needs no
 * network, and runs with no flag, so that a shell's `NODE_USE_ENV_PROXY=1` is the only way its
 * in-process cases could meet a proxy.
 * 0.44 s wall for the gate over 7 mise pins and 1 `packageManager`, asking 8 package versions, and
 * 4.72 s for its 39 cases, 2 s of them the timeout case's wait, through `mise run`
 * (`/usr/bin/time -p`, one run each) on a macOS laptop, 2026-11-08. With 46 cases the selftest took
 * 9.05 s wall and 4.85 s of user and system time, on one run the same day at a one-minute load
 * average of 18.90 from other sessions.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
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
const MANAGERS = 'packageManagerOsvPackages'
const TIMEOUT = 'toolPinQueryTimeoutSeconds'
const RECORD = 'policy/tool-pins.json'
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
// What the gate prints when the environment names a proxy that this Node was not started to use.
const UNUSED_PROXY_LINE =
  'deps:tools: a proxy variable is set, but Node ignores it unless started with --use-env-proxy or NODE_USE_ENV_PROXY=1; ' +
  'run `mise run deps:tools:check`, which passes the flag, or pass it yourself, or this run goes direct'

/** Whether this Node was started to send `fetch` through the environment's proxy. */
const proxySupportOn = () =>
  process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || /(^|\s)--use-env-proxy(\s|$)/.test(process.env.NODE_OPTIONS ?? '')

/**
 * Send loopback traffic direct, whatever proxy the environment names: a stub or a mirror on this
 * machine is never behind one. Node reads `no_proxy` per request, and `NO_PROXY` only when `no_proxy`
 * is unset, so this starts from the one Node reads, adds loopback, and writes both, which keeps a
 * host the shell exempted in `NO_PROXY` alone. IPv6 loopback is `[::1]`, the form Node matches
 * against a request to it; `::1` does not match. All three checked on Node 24.22.1, 2026-11-08.
 */
function directLoopback() {
  const value = [process.env.no_proxy ?? process.env.NO_PROXY, '127.0.0.1', 'localhost', '[::1]'].filter(isText).join(',')
  process.env.no_proxy = value
  process.env.NO_PROXY = value
}
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
    // A tracked file deleted from the working tree pins nothing there, as `deps:check` reads it.
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

/** The two tables and the timeout from `root`'s policy, with a problem for each that cannot be read. */
function readSettings(root, problems) {
  let policy
  try {
    policy = readPolicy(root)
  } catch (error) {
    problems.push(`the policy under ${root} cannot be read, so no pin can be mapped: ${oneLine(error.message)}`)
    return { tables: { [TABLE]: {}, [MANAGERS]: {} }, timeout: null }
  }
  const tableOf = (key) => {
    if (policy[key] === undefined) return {}
    if (isObject(policy[key])) return policy[key]
    problems.push(`${key} in ${RECORD} is not a table keyed by tool, so no pin can be mapped through it`)
    return {}
  }
  const timeout = Number.isInteger(policy[TIMEOUT]) && policy[TIMEOUT] >= 1 ? policy[TIMEOUT] : null
  if (timeout === null) problems.push(`${RECORD} names no \`${TIMEOUT}\`, a whole number of seconds of at least 1, so how long to wait for osv.dev is unknown`)
  return { tables: { [TABLE]: tableOf(TABLE), [MANAGERS]: tableOf(MANAGERS) }, timeout }
}

/** Why the row for `tool` in `table` cannot be read, or `null`. */
function rowProblem(table, tool, row) {
  const at = `${table}.${tool}`
  const packages = isObject(row) && Array.isArray(row.packages) && row.packages.length > 0 && row.packages.every(isText)
  const mapped = isObject(row) && isText(row.ecosystem) && packages
  const unchecked = isObject(row) && row.unchecked === true
  if (mapped === unchecked) return `${at} names no osv.dev ecosystem and packages, or names them beside \`unchecked\`: a row is one or the other`
  if (!isText(row.means)) return `${at} has no \`means\` saying why it maps the tool as it does`
  for (const [id, acceptance] of Object.entries(row.accepted ?? {})) {
    if (!DATE.test(acceptance?.until ?? '') || !isText(acceptance?.reason)) return `${at} accepts ${id} with no \`until\` date (YYYY-MM-DD) and \`reason\``
  }
  return null
}

/** Why a Go package cannot hold `version`, or `null`: from major version 2, Go names a module `<path>/vN`. */
function goMajorProblem(name, version) {
  const suffix = /\/v(\d+)$/.exec(name)
  const major = Number(version.split('.')[0])
  if (suffix ? Number(suffix[1]) === major : !(major >= 2)) return null
  return `the module path ${suffix ? `ends in /v${suffix[1]}` : 'has no /vN suffix'}, which Go gives major version ${suffix ? suffix[1] : '0 or 1'}, not ${version}; move the row's package with the pin, or osv.dev answers nothing for it`
}

/** osv.dev's results for `queries`, one per query in order, or the problem that kept them back. */
async function ask(api, queries, seconds) {
  const url = `${api}/v1/querybatch`
  let response
  let text
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: queries.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version })) }),
      signal: AbortSignal.timeout(seconds * 1000),
    })
    text = await response.text()
  } catch (error) {
    if (error.name === 'TimeoutError') return { problem: `osv.dev did not answer within ${seconds} s at ${url}, so the pins were not checked` }
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
  // Before the policy is read, since the policy loader refuses a tree with no record at all.
  if (pins.length === 0 && problems.length === 0) {
    return { status: 'skip', lines: ['no mise.toml, mise.lock or packageManager pins a tool, so nothing to check'], unchecked: [] }
  }
  const { tables, timeout } = readSettings(root, problems)
  const miseTools = new Set(pins.filter((p) => !p.packageManager).map((p) => p.tool))
  const rows = { [TABLE]: new Map(), [MANAGERS]: new Map() }
  const unreadable = { [TABLE]: new Set(), [MANAGERS]: new Set() }
  for (const table of [TABLE, MANAGERS]) {
    for (const tool of Object.keys(tables[table]).sort(byCodePoint)) {
      const problem = rowProblem(table, tool, tables[table][tool])
      if (problem) {
        problems.push(problem)
        unreadable[table].add(tool)
      } else if (table === TABLE && !miseTools.has(tool)) {
        problems.push(`${TABLE} names \`${tool}\`, which neither mise.toml nor mise.lock pins: its row goes with its pin`)
      } else {
        rows[table].set(tool, tables[table][tool])
      }
    }
  }
  const queries = new Map()
  const unchecked = new Map()
  const unmapped = new Map()
  const add = (map, key, item) => map.set(key, [...(map.get(key) ?? []), item])
  for (const pin of pins) {
    const table = pin.packageManager ? MANAGERS : TABLE
    const row = rows[table].get(pin.tool)
    if (row === undefined) {
      if (!unreadable[table].has(pin.tool)) add(unmapped, `${table}\0${pin.tool}`, `${pin.source} ${pin.version}`)
      continue
    }
    if (row.unchecked) {
      add(unchecked, `${pin.tool} ${pin.version}\0, whose row says osv.dev covers no ecosystem it is published in`, pin.source)
      continue
    }
    for (const name of row.packages) {
      const key = `${row.ecosystem}\0${name}\0${pin.version}`
      const query = queries.get(key) ?? { ecosystem: row.ecosystem, name, version: pin.version, sources: [], accepted: {} }
      query.sources.push(pin.packageManager ? pin.source : `${pin.source} ${pin.tool}`)
      Object.assign(query.accepted, row.accepted)
      queries.set(key, query)
    }
  }
  for (const key of [...unmapped.keys()].sort(byCodePoint)) {
    const [table, tool] = key.split('\0')
    problems.push(
      `${tool} (${unmapped.get(key).join(', ')}) has no row in ${table} (${RECORD}): add the osv.dev ecosystem and packages it is published as, or \`unchecked: true\`, with the reason in \`means\``,
    )
  }
  const list = [...queries.values()]
  const label = (query) => `${query.ecosystem} ${query.name}@${query.version} (${query.sources.join(', ')})`
  for (const query of list.filter((q) => q.ecosystem === 'Go')) {
    const problem = goMajorProblem(query.name, query.version)
    if (problem) problems.push(`${label(query)}: ${problem}`)
  }
  const findings = []
  if (list.length > 0 && timeout !== null) {
    const { problem, results } = await ask(api, list, timeout)
    if (problem) problems.push(problem)
    else {
      list.forEach((query, i) => {
        if (results[i].next_page_token !== undefined) {
          findings.push(`${label(query)}: osv.dev holds more advisories than one page answers, so they cannot all be named; move the pin`)
          return
        }
        const open = []
        for (const { id } of results[i].vulns ?? []) {
          const acceptance = query.accepted[id]
          if (acceptance && acceptance.until >= today) continue
          open.push(acceptance ? `${id}, whose acceptance ended ${acceptance.until}` : id)
        }
        if (open.length > 0) findings.push(`${label(query)}: ${open.sort(byCodePoint).join(', ')}`)
      })
    }
  }
  const uncheckedLines = [...unchecked.keys()].sort(byCodePoint).map((key) => {
    const [pin, why] = key.split('\0')
    return `${pin} (${unchecked.get(key).join(', ')})${why}`
  })
  if (problems.length > 0 || findings.length > 0) return { status: 'fail', lines: [...problems, ...findings.sort(byCodePoint)], unchecked: uncheckedLines }
  return { status: 'pass', lines: [`${list.length} package version(s) asked of osv.dev, and no known advisory`], unchecked: uncheckedLines }
}

async function main() {
  // Node's fetch reads the proxy variables only when Node starts with the flag or the variable, and
  // setting the variable from inside the process is too late. The task passes the flag; a run by hand
  // without it is told so, and goes on, failing closed if osv.dev is reachable only through the proxy.
  if (PROXY_VARS.some((name) => process.env[name]) && !proxySupportOn()) console.error(`${UNUSED_PROXY_LINE}.`)
  directLoopback()
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
  { id: 'FIX-MOVED-1', ecosystem: 'Go', name: 'example.com/fixture/moved', versions: ['1.0.2'] },
]

/**
 * A stub of osv.dev's batch endpoint on loopback, which also answers as an HTTP proxy would be asked.
 * `state.mode` makes it misbehave; `state.asked` is the last request's queries, and `state.proxied`
 * whether that request came through a proxy. `host` is the loopback address it listens on.
 */
async function stub(host = '127.0.0.1') {
  const state = { mode: 'ok', asked: [], proxied: false }
  const timers = new Set()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const proxied = /^https?:\/\//.test(req.url)
      if (req.method !== 'POST' || (proxied ? new URL(req.url).pathname : req.url) !== '/v1/querybatch') {
        res.writeHead(404)
        return res.end('not found')
      }
      const { queries } = JSON.parse(body)
      state.asked = queries.map((q) => `${q.package.ecosystem} ${q.package.name} ${q.version}`).sort(byCodePoint)
      if (proxied) state.proxied = true
      const results = queries.map((q) => {
        const vulns = ADVISORIES.filter((a) => a.ecosystem === q.package.ecosystem && a.name === q.package.name && a.versions.includes(q.version))
        return vulns.length > 0 ? { vulns: vulns.map(({ id }) => ({ id, modified: '2026-11-08T00:00:00Z' })) } : {}
      })
      if (state.mode === 'slow') {
        // Answers clean, but only after the fixtures' 2 s timeout, so a gate that waits passes.
        const timer = setTimeout(() => {
          timers.delete(timer)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ results: queries.map(() => ({})) }))
        }, 5000)
        timers.add(timer)
        return
      }
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
      if (state.mode === 'no-id') results[0] = { vulns: [{ modified: '2026-11-08T00:00:00Z' }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results }))
    })
  })
  // Node's fetch asks a proxy for a CONNECT tunnel, for an http:// address too, so the stub opens
  // each tunnel back to itself and answers the query that comes through it.
  const tunnels = new Set()
  server.on('connect', (req, socket, head) => {
    state.proxied = true
    const upstream = connect(server.address().port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    for (const end of [socket, upstream]) {
      tunnels.add(end)
      end.on('error', () => {})
      end.on('close', () => tunnels.delete(end))
    }
  })
  await new Promise((done, fail) => server.once('error', fail).listen(0, host, done))
  const close = () => {
    for (const timer of timers) clearTimeout(timer)
    for (const end of tunnels) end.destroy()
    server.closeAllConnections()
    return new Promise((done) => server.close(done))
  }
  return { url: `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`, state, close }
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
  node: { ecosystem: 'Bitnami', packages: ['node'], means: 'a fixture row' },
  'npm:pnpm': { ecosystem: 'npm', packages: ['pnpm'], means: 'a fixture row' },
  'github:fixture/tool': { ecosystem: 'Go', packages: ['example.com/fixture/tool', 'example.com/fixture/moved'], means: 'a fixture row with two module paths' },
  'github:fixture/major': { ecosystem: 'Go', packages: ['example.com/fixture/major/v2'], means: 'a fixture row at major version 2' },
  'fixture-unchecked': { unchecked: true, means: 'a fixture tool no ecosystem covers' },
}
const MANAGER_ROWS = { pnpm: { ecosystem: 'npm', packages: ['pnpm'], means: 'a fixture row' } }
const VERSIONS = { node: '1.0.1', 'npm:pnpm': '1.0.1', 'github:fixture/tool': '1.0.1', 'github:fixture/major': '2.0.1', 'fixture-unchecked': '1.0.1' }
const acceptNode = (acceptance) => ({ node: { ...ROWS.node, accepted: { 'FIX-NODE-1': acceptance } } })

/**
 * The files of a case: the undoctored fixture with `tools` (TOML values), `locked`, `packageManager`,
 * `rows`, `managers`, `table`, `timeout` and `files` laid over it.
 */
function caseFiles(c) {
  if (c.only) return c.only
  const tools = { ...Object.fromEntries(Object.entries(VERSIONS).map(([tool, version]) => [tool, `"${version}"`])), ...c.tools }
  const locked = { ...VERSIONS, ...c.locked }
  const policy = { [TABLE]: c.table ?? { ...ROWS, ...c.rows }, [MANAGERS]: { ...MANAGER_ROWS, ...c.managers }, [TIMEOUT]: 2 }
  if (c.timeout === null) delete policy[TIMEOUT]
  return {
    'mise.toml': `[tools]\n${Object.entries(tools).map(([tool, value]) => `${tomlKey(tool)} = ${value}\n`).join('')}`,
    'mise.lock': `lockfile_version = 3\n${Object.entries(locked).map(([tool, version]) => `\n[[tools.${tomlKey(tool)}]]\nversion = "${version}"\nbackend = "fixture:${tool}"\n`).join('')}`,
    'package.json': json({ name: 'fixture', private: true }),
    'src/package.json': json({ name: 'fixture-src', private: true, packageManager: c.packageManager ?? 'pnpm@1.0.1' }),
    'policy/tool-pins.json': json(policy),
    ...c.files,
  }
}

const CLEAN = /^5 package version\(s\) asked of osv\.dev, and no known advisory$/
const ASKED = [
  'Bitnami node 1.0.1',
  'Go example.com/fixture/major/v2 2.0.1',
  'Go example.com/fixture/moved 1.0.1',
  'Go example.com/fixture/tool 1.0.1',
  'npm pnpm 1.0.1',
]

function cases(closed) {
  return [
    {
      name: 'control: every pin clean, and one unchecked',
      expect: CLEAN,
      asked: ASKED,
      unchecked: /^fixture-unchecked 1\.0\.1 \(mise\.toml, mise\.lock\), whose row says osv\.dev covers no ecosystem it is published in$/,
    },
    { name: 'a vulnerable version in mise.toml', tools: { node: '"1.0.0"' }, refuse: /^Bitnami node@1\.0\.0 \(mise\.toml node\): FIX-NODE-1$/ },
    { name: 'a vulnerable version in mise.lock', locked: { 'github:fixture/tool': '1.0.0' }, refuse: /^Go example\.com\/fixture\/tool@1\.0\.0 \(mise\.lock github:fixture\/tool\): FIX-GO-1$/ },
    {
      name: "a vulnerable version under a row's second package",
      tools: { 'github:fixture/tool': '"1.0.2"' },
      locked: { 'github:fixture/tool': '1.0.2' },
      refuse: /^Go example\.com\/fixture\/moved@1\.0\.2 \(mise\.toml github:fixture\/tool, mise\.lock github:fixture\/tool\): FIX-MOVED-1$/,
    },
    { name: "a vulnerable packageManager, with corepack's hash", packageManager: 'pnpm@2.0.0+sha512.fixture', refuse: /^npm pnpm@2\.0\.0 \(src\/package\.json packageManager\): FIX-PNPM-1$/ },
    { name: 'an untracked package.json is not read', untracked: { 'stray/package.json': json({ packageManager: 'pnpm@2.0.0' }) }, expect: CLEAN },
    { name: 'a tracked package.json missing from the working tree is not read', removed: ['src/package.json'], expect: CLEAN },
    {
      name: 'a packageManager with no row',
      packageManager: 'yarn@4.1.0',
      refuse: /^yarn \(src\/package\.json packageManager 4\.1\.0\) has no row in packageManagerOsvPackages \(policy\/tool-pins\.json\): add the osv\.dev ecosystem and packages it is published as/,
    },
    { name: 'a packageManager with no version', packageManager: 'pnpm', refuse: /^src\/package\.json names "pnpm" as its packageManager, not `<name>@<version>`/ },
    { name: 'a package.json that is not JSON', files: { 'src/package.json': '{\n' }, refuse: /^src\/package\.json cannot be read as JSON/ },
    { name: 'a pin that is not a version string', tools: { node: '{ version = "1.0.1" }' }, refuse: /^mise\.toml pins node as \{"version":"1\.0\.1"\}, not a version string/ },
    { name: 'a mise.toml that is not TOML', files: { 'mise.toml': '[tools\n' }, refuse: /^mise\.toml cannot be read as TOML/ },
    { name: 'a pin with no row', tools: { extra: '"1.0.1"' }, locked: { extra: '1.0.1' }, refuse: /^extra \(mise\.toml 1\.0\.1, mise\.lock 1\.0\.1\) has no row in toolPinOsvPackages/ },
    { name: 'a row that names no pin', rows: { gone: { unchecked: true, means: 'a fixture row' } }, refuse: /^toolPinOsvPackages names `gone`, which neither mise\.toml nor mise\.lock pins/ },
    { name: 'a row with neither packages nor unchecked', rows: { node: { ecosystem: 'Bitnami', means: 'a fixture row' } }, refuse: /^toolPinOsvPackages\.node names no osv\.dev ecosystem and packages/ },
    { name: 'a row with both packages and unchecked', rows: { node: { ...ROWS.node, unchecked: true } }, refuse: /^toolPinOsvPackages\.node names no osv\.dev ecosystem and packages, or names them beside `unchecked`/ },
    {
      name: 'a row whose packages is a string, against a vulnerable pin',
      tools: { node: '"1.0.0"' },
      locked: { node: '1.0.0' },
      rows: { node: { ecosystem: 'Bitnami', packages: 'node', means: 'a fixture row' } },
      refuse: /^toolPinOsvPackages\.node names no osv\.dev ecosystem and packages/,
    },
    {
      name: 'a pin whose row cannot be read is not also called rowless',
      rows: { node: { ecosystem: 'Bitnami', means: 'a fixture row' } },
      refuse: /^toolPinOsvPackages\.node names no osv\.dev ecosystem and packages/,
      absent: /^node \(.+\) has no row/,
    },
    { name: 'a row with no means', rows: { node: { ecosystem: 'Bitnami', packages: ['node'] } }, refuse: /^toolPinOsvPackages\.node has no `means`/ },
    { name: 'a packageManager row it cannot read', managers: { pnpm: { ecosystem: 'npm', means: 'a fixture row' } }, refuse: /^packageManagerOsvPackages\.pnpm names no osv\.dev ecosystem and packages/ },
    { name: 'a table that is not keyed by tool', table: ['node'], refuse: /^toolPinOsvPackages in policy\/tool-pins\.json is not a table keyed by tool/ },
    { name: 'a policy that cannot be read', files: { 'policy/tool-pins.json': '{\n' }, refuse: /^the policy under .+ cannot be read, so no pin can be mapped/ },
    { name: 'a policy with no timeout', timeout: null, refuse: /^policy\/tool-pins\.json names no `toolPinQueryTimeoutSeconds`/ },
    {
      name: 'a Go module path behind a major-version bump',
      tools: { 'github:fixture/major': '"3.0.0"' },
      locked: { 'github:fixture/major': '3.0.0' },
      refuse: /^Go example\.com\/fixture\/major\/v2@3\.0\.0 \(mise\.toml github:fixture\/major, mise\.lock github:fixture\/major\): the module path ends in \/v2/,
    },
    {
      name: 'a Go module path with no /vN at major version 2',
      tools: { 'github:fixture/tool': '"2.0.0"' },
      locked: { 'github:fixture/tool': '2.0.0' },
      refuse: /^Go example\.com\/fixture\/tool@2\.0\.0 \(mise\.toml github:fixture\/tool, mise\.lock github:fixture\/tool\): the module path has no \/vN suffix/,
    },
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
    { name: 'an osv.dev that does not answer within the timeout', mode: 'slow', refuse: /^osv\.dev did not answer within 2 s at http:\/\/127\.0\.0\.1:\d+\/v1\/querybatch/ },
    { name: 'osv.dev answering an error', mode: 'status', refuse: /^osv\.dev answered 503 at http:\/\/127\.0\.0\.1:\d+\/v1\/querybatch/ },
    { name: 'osv.dev answering what is not JSON', mode: 'garbage', refuse: /^osv\.dev's answer at http:\/\/127\.0\.0\.1:\d+\/v1\/querybatch is not JSON/ },
    { name: 'osv.dev answering too few results', mode: 'short', refuse: /^osv\.dev's answer is not one result per query/ },
    { name: 'osv.dev answering an advisory with no id', mode: 'no-id', refuse: /^osv\.dev's answer is not one result per query, each a list of advisory ids/ },
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
  for (const path of c.removed ?? []) rmSync(join(dir, path))
  return dir
}

// How long one run of the gate in a child may take. A run takes under a second; the bound turns a hang into a named FAIL.
const GATE_RUN_LIMIT_MS = 30_000

/**
 * The command `deps:tools:check` runs, read from this checkout's `tasks.toml`: this Node, the task's
 * Node flags, and this file in place of the script it names, so a copy under test runs itself. The
 * end-to-end cases run it, so a flag dropped from the task's run line fails a case.
 */
function taskCommand() {
  const run = parseToml(readFileSync(join(REPO_ROOT, 'tasks.toml'), 'utf8'))['deps:tools:check']?.run
  const [node, ...words] = typeof run === 'string' ? run.trim().split(/\s+/) : []
  const script = words.findIndex((word) => !word.startsWith('-'))
  if (node !== 'node' || script === -1) throw new Error(`tasks.toml's deps:tools:check runs ${JSON.stringify(run)}, not \`node [flags] <script>\``)
  return [process.execPath, ...words.slice(0, script), SELF, ...words.slice(script + 1)]
}

/**
 * Run this gate as a hook and CI do, through the task's command, or as a person would by hand with
 * `bare`; with no proxy unless `env` sets one, and without blocking the stub. A run that outlasts
 * `GATE_RUN_LIMIT_MS` is killed and reported at once, without waiting for its pipes to close.
 */
function runGate(env, { bare = false } = {}) {
  // Dropped, not emptied: Node reads `http_proxy` before `HTTP_PROXY`, and an empty one means no proxy.
  // `NODE_OPTIONS` loses only the proxy flag, which would give a run by hand proxy support it lacks.
  const inherited = { ...process.env }
  for (const name of [...PROXY_VARS, 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete inherited[name]
  if (inherited.NODE_OPTIONS !== undefined) inherited.NODE_OPTIONS = inherited.NODE_OPTIONS.replace(/(^|\s)--use-env-proxy(?=\s|$)/g, ' ').trim()
  const [command, ...args] = bare ? [process.execPath, SELF] : taskCommand()
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ stdout, stderr, ...result })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ status: null, killed: `still running after ${GATE_RUN_LIMIT_MS / 1000} s` })
    }, GATE_RUN_LIMIT_MS)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => settle({ status: null, killed: `could not start: ${error.message}` }))
    child.on('close', (status) => settle({ status, killed: null }))
  })
}

/** The line a `runGate` result adds to a FAIL: its kill, or its exit and output. */
const gateSaid = (run) => (run.killed ? `killed, ${run.killed}` : `exited ${run.status}: ${run.stdout}${run.stderr}`)

async function selftest() {
  // The in-process cases talk to a stub on loopback, which a Node the shell started with
  // NODE_USE_ENV_PROXY=1 would otherwise send to the shell's proxy.
  directLoopback()
  const base = mkdtempSync(join(tmpdir(), 'check-tool-pins-'))
  const osv = await stub()
  const results = []
  // One case, whatever it throws, as a named result, so a crash in one case leaves the rest to run. A
  // check returns null when it holds, its problem when it does not, or `{ skipped }` with the reason
  // its input is legitimately absent here.
  const hold = async (name, check) => {
    try {
      const problem = await check()
      if (problem?.skipped) {
        results.push({ name, ok: true, detail: `skipped, ${problem.skipped}` })
        return null
      }
      results.push({ name, ok: problem === null, detail: problem ?? 'holds' })
      return problem
    } catch (error) {
      results.push({ name, ok: false, detail: `threw: ${oneLine(error.stack ?? error.message)}` })
      return `threw: ${oneLine(error.message)}`
    }
  }
  try {
    const all = cases(await closedUrl())
    const dirs = new Map()
    for (const c of all) {
      const problem = await hold(c.name, async () => {
        const dir = fixture(base, c)
        dirs.set(c.name, dir)
        osv.state.mode = c.mode ?? 'ok'
        osv.state.asked = []
        const { status, lines, unchecked } = await runCheck(dir, { api: c.api ?? osv.url })
        const said = lines.join(' | ')
        const [want, reason] = c.refuse ? ['fail', c.refuse] : c.skip ? ['skip', c.skip] : ['pass', c.expect]
        if (status !== want) return `${status}, not ${want}: ${said}`
        if (!lines.some((line) => reason.test(line))) return `${status}, but not for that reason: ${said}`
        if (c.absent && lines.some((line) => c.absent.test(line))) return `${status}, and also says ${JSON.stringify(lines.find((line) => c.absent.test(line)))}`
        if (c.asked && JSON.stringify(osv.state.asked) !== JSON.stringify(c.asked)) return `asked osv.dev for ${JSON.stringify(osv.state.asked)}, not ${JSON.stringify(c.asked)}`
        if (c.unchecked && !unchecked.some((line) => c.unchecked.test(line))) return `named ${JSON.stringify(unchecked)} as unchecked`
        return null
      })
      if (c.name.startsWith('control') && problem) {
        console.error(`selftest: the undoctored fixture does not pass, so no case can be trusted: ${problem}`)
        process.exit(1)
      }
    }
    // The gate end to end through its root override, so the exit and the lines a hook and CI read are
    // held too: the control passes and names its unchecked pin, and a vulnerable pin exits 1.
    osv.state.mode = 'ok'
    await hold('TOOL_PINS_CHECK_ROOT points the gate at a passing copy', async () => {
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: osv.url })
      const passes =
        run.status === 0 &&
        /^deps:tools: unchecked, fixture-unchecked 1\.0\.1 \(mise\.toml, mise\.lock\)/m.test(run.stdout) &&
        /^deps:tools: 5 package version\(s\) asked of osv\.dev, and no known advisory\.$/m.test(run.stdout)
      return passes ? null : gateSaid(run)
    })
    await hold('TOOL_PINS_CHECK_ROOT points the gate at a refused copy', async () => {
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get('a vulnerable version in mise.toml'), TOOL_PINS_OSV_API_URL: osv.url })
      return run.status === 1 && /^ {2}- Bitnami node@1\.0\.0 \(mise\.toml node\): FIX-NODE-1$/m.test(run.stderr) ? null : gateSaid(run)
    })
    // An osv.dev the gate can reach only through the proxy the environment names, as a push behind a
    // corporate proxy meets it: the `.invalid` name resolves nowhere, so only the proxy can answer.
    // It holds the task's `--use-env-proxy`, without which the query goes direct and fails.
    await hold("an HTTP_PROXY in the environment carries the query, through the task's flag", async () => {
      osv.state.proxied = false
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: 'http://osv.fixture.invalid', HTTP_PROXY: osv.url })
      if (run.status !== 0 || !osv.state.proxied) return `proxied ${osv.state.proxied}, ${gateSaid(run)}`
      return run.stderr.includes(UNUSED_PROXY_LINE) ? `said it could not use the proxy: ${gateSaid(run)}` : null
    })
    // A proxy that refuses every connection, with osv.dev on loopback: the gate must go direct.
    const closed = await closedUrl()
    await hold('loopback goes direct past a proxy the environment names', async () => {
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: osv.url, HTTP_PROXY: closed, HTTPS_PROXY: closed })
      return run.status === 0 && /^deps:tools: 5 package version\(s\) asked of osv\.dev, and no known advisory\.$/m.test(run.stdout) ? null : gateSaid(run)
    })
    // A host the shell exempts in upper-case `NO_PROXY` alone must still go direct. The `.invalid`
    // name resolves nowhere, so going direct fails with ENOTFOUND, and only the proxy could answer.
    await hold('a host only NO_PROXY exempts goes direct, not through the proxy', async () => {
      osv.state.proxied = false
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: 'http://osv.fixture.invalid', HTTP_PROXY: osv.url, NO_PROXY: 'osv.fixture.invalid' })
      const direct = run.status === 1 && !osv.state.proxied && run.stderr.includes('could not be reached at http://osv.fixture.invalid (ENOTFOUND)')
      return direct ? null : `proxied ${osv.state.proxied}, ${gateSaid(run)}`
    })
    // IPv6 loopback, past a proxy that refuses every connection: the gate must go direct to `[::1]`.
    await hold('IPv6 loopback goes direct past a proxy the environment names', async () => {
      let osv6
      try {
        osv6 = await stub('::1')
      } catch (error) {
        return { skipped: `this machine cannot listen on ::1 (${error.code ?? error.message})` }
      }
      try {
        const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: osv6.url, HTTP_PROXY: closed, HTTPS_PROXY: closed })
        return run.status === 0 && /^deps:tools: 5 package version\(s\) asked of osv\.dev, and no known advisory\.$/m.test(run.stdout) ? null : gateSaid(run)
      } finally {
        await osv6.close()
      }
    })
    // Run by hand, without the flag, with a proxy set: the gate says it cannot use it, and goes on.
    await hold('a proxy a run by hand cannot use is named, and the run goes on', async () => {
      const run = await runGate({ TOOL_PINS_CHECK_ROOT: dirs.get(all[0].name), TOOL_PINS_OSV_API_URL: osv.url, HTTP_PROXY: closed }, { bare: true })
      return run.status === 0 && run.stderr.includes(UNUSED_PROXY_LINE) ? null : gateSaid(run)
    })
    // The selftest's own loopback traffic, which a shell's NODE_USE_ENV_PROXY=1 would send to a proxy.
    await hold('the selftest sends its own loopback traffic direct', async () => {
      const missing = ['NO_PROXY', 'no_proxy'].filter((name) => !(process.env[name] ?? '').split(',').includes('127.0.0.1'))
      return missing.length === 0 ? null : `${missing.join(' and ')} leave 127.0.0.1 out, so a proxy the shell names would carry the stub's traffic`
    })
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

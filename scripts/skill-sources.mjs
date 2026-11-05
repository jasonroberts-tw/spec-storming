/**
 * Skill sources: holds `policy/skill-sources.json` to its rules, and makes a machine's Claude Code
 * plugins and `skills`-CLI skills match it.
 *
 * THE FAILURE IT EXISTS TO PREVENT. Without it a plugin reaches a machine only when a person runs
 * the setup commands by hand, a plugin dropped from the list stays installed on every machine, and
 * a skill from the `skills` CLI has no route at all, or lands as untracked files that look like the
 * repository's own. The plan is `plans/skill-management-plan-generic.md` in the template's source.
 *
 *   mise run skills:check      (check) refuses a row the record's `gatedBy` lists; committed files only
 *   mise run skills:install    (sync) acts on each difference between the record and this machine
 *   mise run skills:selftest   (--selftest) each refusal, and each sync row over stub `claude`,
 *                              stub `skills` and a stub skills.sh on loopback
 *   node scripts/skill-sources.mjs audit <owner>/<repo> <skill>   the skills.sh audit, as admission reads it
 *   node scripts/skill-sources.mjs scan <dir>                     the command guards over a skill's code blocks
 *   node scripts/skill-sources.mjs copy <worktree>                installed skills into a new worktree, offline
 *
 * sync's flags: --dry-run prints each action as `would ...` and changes nothing, which the doctor
 * reads as drift; --warn-only prints a failure and exits 0, for the entrypoint and the git hooks;
 * --owns-user-config removes a marketplace nothing wanted uses, where the Claude Code config
 * directory is this machine's alone (the container); --since <rev> does nothing unless the record
 * or `.claude/settings.json` changed between <rev> and HEAD, for the post-checkout and post-merge jobs.
 *
 * sync works on the primary checkout, whose path the plugins' project records name. It removes only
 * what it owns: a project record for this clone, and an untracked skill directory the `skills`
 * CLI's lock records. It runs the `skills` CLI with telemetry off, no GitHub token and a `gh` that
 * fails, and reads skills.sh with no token. It skips with its reason when `claude` or
 * `node_modules/.bin/skills` is absent; a tool found that then fails is a failure.
 *
 * NEEDS Node and git; nothing from node_modules, so it runs before `npm ci` and in a fresh worktree.
 * PROBED on 2026-10-12, with Claude Code 2.1.296, `skills` 1.7.2 and a throwaway CLAUDE_CONFIG_DIR:
 * a project record's `projectPath` is the checkout the install ran in, so an install from a linked
 * worktree records the worktree, which is why sync runs from the primary checkout; `claude plugin
 * install --scope project` rewrites `.claude/settings.json` with `enabledPlugins` as its last key,
 * and `uninstall` deletes the plugin's entry there and leaves a file without one unchanged, so a
 * rendered file is left alone and any edit is a failure; `install` needs no terminal and no `-y`
 * for a plugin with no command; `skills add <source>#<sha> --copy` writes only
 * `.claude/skills/<name>/` and `skills-lock.json`, whose `ref` is the SHA; `skills remove -a
 * claude-code -s <name> -y` deletes both and exits 0 when it finds nothing. Linked worktrees share
 * `info/exclude`. The JSON shapes of `claude plugin ... list --json`, skills.sh's audit and
 * `skills-lock.json` were read from the real things.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnv, gitIn, gitOk } from '../tools/lib/git-env.ts'
import { copyPolicy, editPolicy, readPolicy } from '../tools/lib/policy.ts'

const SELF = fileURLToPath(import.meta.url)
const SCRIPT_ROOT = resolve(dirname(SELF), '..')
const AUDIT_URL = process.env.SKILLS_AUDIT_URL ?? 'https://skills.sh/api/v1/skills/audit'
const SHA = /^[0-9a-f]{40}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const STATUS = { pass: 0, warn: 1, fail: 2 }
const RISK = { NONE: 0, SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }
const WATCHED = ['policy/skill-sources.json', '.claude/settings.json']
const RULES = ['AGENTS.md', 'CLAUDE.md']
const EXCLUDE_BEGIN = '# skill-sources: installed skills (scripts/skill-sources.mjs sync)'
const EXCLUDE_END = '# skill-sources: end'
const ASSESSOR_TOOLS = 'Read, Grep, Glob'
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

function lists(root) {
  const policy = readPolicy(root)
  return {
    plugins: Array.isArray(policy.claudeEnabledPlugins) ? policy.claudeEnabledPlugins : [],
    markets: object(policy.claudePluginMarketplaces),
    skills: object(policy.installedSkills),
    timeout: Number(policy.skillAuditTimeoutSeconds) || 5,
  }
}

/** The pin `mise.toml` gives `tool` under [tools], or null. */
function misePin(root, tool) {
  const text = existsSync(join(root, 'mise.toml')) ? readFileSync(join(root, 'mise.toml'), 'utf8') : ''
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*"?${escaped}"?\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1] ?? null
}

/** Whether an accepted audit was all `pass`: anything else, or no audit at all, is a finding. */
const auditClean = (audit) => Object.keys(object(audit)).length > 0 && Object.values(object(audit)).every((a) => a?.status === 'pass')

/** Every problem with the committed record under `root`; empty when it holds. */
export function check(root) {
  const policy = readPolicy(root)
  const problems = []
  const plugins = policy.claudeEnabledPlugins ?? []
  const markets = policy.claudePluginMarketplaces ?? {}
  const skills = policy.installedSkills ?? {}
  if (!Array.isArray(plugins)) return ['claudeEnabledPlugins is not a list']
  if (object(markets) !== markets) return ['claudePluginMarketplaces is not a table']
  if (object(skills) !== skills) return ['installedSkills is not a table']
  const used = new Set()
  for (const id of plugins) {
    const market = typeof id === 'string' ? /^[^@\s]+@([^@\s]+)$/.exec(id)?.[1] : null
    if (!market) { problems.push(`claudeEnabledPlugins: ${JSON.stringify(id)} is not <plugin>@<marketplace>`); continue }
    used.add(market)
    if (!markets[market]) problems.push(`${id}: its marketplace ${market} has no row in claudePluginMarketplaces`)
  }
  for (const [name, row] of Object.entries(markets)) {
    const tag = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(.+)$/.exec(row?.source ?? '')?.[1]
    if (!tag) problems.push(`marketplace ${name}: source ${JSON.stringify(row?.source)} is not <owner>/<repo>#<tag>`)
    if (!isText(row?.means)) problems.push(`marketplace ${name}: no \`means\` saying why`)
    if (!used.has(name)) problems.push(`marketplace ${name}: no enabled plugin uses it`)
    if (row?.heldTo !== undefined) {
      const pin = misePin(root, String(row.heldTo))
      if (!pin) problems.push(`marketplace ${name}: heldTo ${row.heldTo} has no pin in mise.toml`)
      else if (tag && tag.replace(/^v/, '') !== pin) problems.push(`marketplace ${name}: tag ${tag} differs from the mise pin of ${row.heldTo}, ${pin}`)
    }
  }
  for (const [name, row] of Object.entries(skills)) {
    if (!NAME.test(name)) { problems.push(`installed skill ${JSON.stringify(name)}: not a skill directory name`); continue }
    if (!REPO.test(row?.source ?? '')) problems.push(`installed skill ${name}: source ${JSON.stringify(row?.source)} is not <owner>/<repo>`)
    if (!SHA.test(row?.commit ?? '')) problems.push(`installed skill ${name}: commit is not a full 40-character SHA`)
    if (!isText(row?.reason)) problems.push(`installed skill ${name}: no reason`)
    if (existsSync(join(root, '.harness/skills', name))) problems.push(`installed skill ${name}: a tracked skill under .harness/skills/ already holds that name`)
    const assessment = object(row?.assessment)
    if (assessment.commit !== row?.commit) problems.push(`installed skill ${name}: its assessment read ${assessment.commit ?? 'no commit'}, not its pin`)
    if (!SHA.test(assessment.rulesCommit ?? '')) problems.push(`installed skill ${name}: its assessment names no rulesCommit it judged against`)
    if (!Number.isInteger(assessment.findings) || assessment.findings < 0) problems.push(`installed skill ${name}: its assessment gives no findings count`)
    if ((assessment.findings !== 0 || !auditClean(row?.audit)) && !isText(assessment.issue)) {
      problems.push(`installed skill ${name}: its assessment or accepted audit found something, and it names no issue`)
    }
  }
  // The assessor reads untrusted text that may try to instruct it, so it gets no tool that acts.
  const assessor = join(root, '.harness/agents/skill-assessor.md')
  const tools = existsSync(assessor) ? /^tools:[ \t]*(.*)$/m.exec(readFileSync(assessor, 'utf8'))?.[1].trim() ?? null : null
  if (tools !== ASSESSOR_TOOLS) problems.push(`.harness/agents/skill-assessor.md: its tools are ${tools === null ? 'not given' : JSON.stringify(tools)}, not ${ASSESSOR_TOOLS}`)
  return problems
}

/** skills.sh's audit for a skill, as `{ results: { <provider slug>: {status, riskLevel, auditedAt} } }` or `{ error }`. */
export async function readAudit(source, name, seconds = 5) {
  try {
    const response = await fetch(`${AUDIT_URL}/${source}/${name}`, { signal: AbortSignal.timeout(seconds * 1000) })
    if (!response.ok) return { error: `skills.sh answered ${response.status}` }
    const body = await response.json()
    if (!Array.isArray(body?.audits)) return { error: 'skills.sh answered with no audits list' }
    return { results: Object.fromEntries(body.audits.map((a) => [a.slug, { status: a.status, riskLevel: a.riskLevel, auditedAt: a.auditedAt }])) }
  } catch (error) {
    return { error: `skills.sh could not be read: ${error.message}` }
  }
}

const rank = (level) => (level === undefined ? 0 : RISK[String(level).toUpperCase()] ?? 2)

/** Each provider whose result is worse than the one accepted, and whether any is bad enough to hold the skill. */
export function worseAudit(accepted, current) {
  const worse = []
  for (const [slug, now] of Object.entries(current)) {
    const was = object(accepted)[slug]
    const moved = was ? (STATUS[now.status] ?? 2) > (STATUS[was.status] ?? 2) || rank(now.riskLevel) > rank(was.riskLevel) : now.status !== 'pass'
    if (moved) worse.push({ slug, was: was ?? null, now })
  }
  return { worse, hold: worse.some(({ now }) => now.status === 'fail' || rank(now.riskLevel) >= 3) }
}

const brief = (a) => (a ? `${a.status}${a.riskLevel ? ' ' + a.riskLevel : ''}` : 'never seen')

/** The primary checkout of `from`, which the plugins' project records name for every worktree. */
function primaryCheckout(from) {
  return dirname(gitIn(from)(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
}

function onPath(command) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && ['', '.cmd', '.exe'].some((ext) => existsSync(join(dir, command + ext))))
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` exited ${result.status}: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

/** The environment the `skills` CLI runs in: telemetry off, no token, and a `gh` that fails first on the PATH. */
function skillsEnv(stubDir) {
  const env = { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', PATH: stubDir + delimiter + (process.env.PATH ?? '') }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  writeFileSync(join(stubDir, 'gh'), '#!/bin/sh\necho "gh is withheld from the skills CLI" >&2\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(stubDir, 'gh.cmd'), '@echo gh is withheld from the skills CLI 1>&2\r\n@exit /b 1\r\n')
  return env
}

/** The managed lines of info/exclude for `names`, and that file's path. */
function excludeFile(root, names) {
  const path = gitIn(root)(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim()
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const start = text.indexOf(EXCLUDE_BEGIN)
  const end = text.indexOf(EXCLUDE_END)
  const rest = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + EXCLUDE_END.length + 1) : text
  const block = names.length
    ? [EXCLUDE_BEGIN, '/skills-lock.json', ...names.map((n) => `/.claude/skills/${n}/`), EXCLUDE_END, ''].join('\n')
    : ''
  const next = rest + (block && rest && !rest.endsWith('\n') ? '\n' : '') + block
  return { path, changed: next !== text, next }
}

export async function sync({ dryRun = false, warnOnly = false, ownsUserConfig = false, since = null, from = SCRIPT_ROOT } = {}) {
  if (since !== null) {
    const here = gitIn(process.cwd())
    if (/^0+$/.test(since) || !gitOk(here, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`])) return 0
    if (gitOk(here, ['diff', '--quiet', since, 'HEAD', '--', ...WATCHED])) return 0
  }
  const root = primaryCheckout(from)
  const git = gitIn(root)
  const { plugins, markets, skills, timeout } = lists(root)
  const failures = []
  const say = (line) => console.log(line)
  const act = (label, action) => {
    if (dryRun) return say(`would ${label}`)
    say(label)
    try { action() } catch (error) { failures.push(`${label}: ${error.message}`) }
  }

  // Plugins, and the marketplaces they come from.
  if (!onPath('claude')) {
    if (plugins.length) say(`skip: claude not found on the PATH, so ${plugins.length} enabled plugin(s) are not checked`)
  } else {
    const claude = (args) => run('claude', args, { cwd: root, env: gitEnv() })
    const settingsUnchanged = (verb) => {
      if (!gitOk(git, ['diff', '--quiet', '--', '.claude/settings.json'])) {
        throw new Error(`the ${verb} edited .claude/settings.json, a tracked file; restore it with \`git checkout -- .claude/settings.json\``)
      }
    }
    let registered = null
    let records = null
    try {
      registered = JSON.parse(claude(['plugin', 'marketplace', 'list', '--json'])).map((m) => m.name)
      records = JSON.parse(claude(['plugin', 'list', '--json']))
    } catch (error) {
      failures.push(`reading Claude Code's plugins: ${error.message}`)
    }
    if (records) {
      const wanted = new Set(plugins.map((id) => id.split('@')[1]))
      for (const name of wanted) {
        if (registered.includes(name)) continue
        const match = /^([^#]+)#(.+)$/.exec(markets[name]?.source ?? '')
        if (!match) { failures.push(`marketplace ${name} has no <owner>/<repo>#<tag> source; run \`mise run skills:check\``); continue }
        act(`add marketplace ${name} from ${markets[name].source}`, () => claude(['plugin', 'marketplace', 'add', `https://github.com/${match[1]}.git#${match[2]}`]))
      }
      const ours = records.filter((r) => r.scope === 'project' && r.projectPath === root)
      for (const id of plugins) {
        if (!ours.some((r) => r.id === id)) act(`install plugin ${id} for this clone`, () => { claude(['plugin', 'install', id, '--scope', 'project']); settingsUnchanged('install') })
      }
      for (const record of ours) {
        if (plugins.includes(record.id)) continue
        act(`uninstall plugin ${record.id}, no longer enabled`, () => {
          claude(['plugin', 'uninstall', record.id, '--scope', 'project'])
          settingsUnchanged('uninstall')
        })
      }
      for (const name of registered.filter((n) => !wanted.has(n))) {
        if (ownsUserConfig) act(`remove marketplace ${name}, which nothing enabled uses`, () => claude(['plugin', 'marketplace', 'remove', name]))
        else say(`note: marketplace ${name} is registered and no enabled plugin here uses it; left, since the config directory is yours`)
      }
    }
  }

  // Skills the `skills` CLI installs.
  const lockPath = join(root, 'skills-lock.json')
  const lock = existsSync(lockPath) ? object(JSON.parse(readFileSync(lockPath, 'utf8')).skills) : {}
  const tracked = (name) => git(['ls-files', '--', `.claude/skills/${name}`]).trim() !== ''
  const present = (name) => existsSync(join(root, '.claude/skills', name, 'SKILL.md'))
  const owned = (name) => lock[name] !== undefined && !tracked(name)
  const cli = join(root, 'node_modules/.bin/skills')
  const unwanted = Object.keys(lock).filter((name) => !Object.hasOwn(skills, name) && owned(name))
  const names = Object.keys(skills).filter((name) => NAME.test(name))
  if ((names.length || unwanted.length) && !existsSync(cli)) {
    say(`skip: node_modules/.bin/skills not found, so ${names.length + unwanted.length} installed skill(s) are not checked; run \`npm ci\`, which installs the skills CLI`)
  } else if (names.length || unwanted.length) {
    const stub = mkdtempSync(join(tmpdir(), 'skill-sources-'))
    const env = skillsEnv(stub)
    const skillsCli = (args) => run(cli, args, { cwd: root, env })
    const add = (name, row) => {
      skillsCli(['add', `${row.source}#${row.commit}`, '-a', 'claude-code', '-s', name, '--copy', '-y'])
      if (!present(name)) throw new Error(`skills add exited 0 and wrote no .claude/skills/${name}/SKILL.md`)
    }
    const remove = (name) => {
      skillsCli(['remove', '-a', 'claude-code', '-s', name, '-y'])
      if (existsSync(join(root, '.claude/skills', name))) throw new Error(`skills remove exited 0 and left .claude/skills/${name}/`)
    }
    try {
      for (const name of names) {
        const row = skills[name]
        if (tracked(name)) continue
        const audit = await readAudit(row.source, name, timeout)
        let hold = false
        if (audit.error) say(`warn: ${name}: ${audit.error}; the accepted audit stands`)
        else {
          const verdict = worseAudit(row.audit, audit.results)
          for (const { slug, was, now } of verdict.worse) say(`${verdict.hold ? 'held' : 'warn'}: ${name}: ${slug} is now ${brief(now)}, accepted ${brief(was)}`)
          if (verdict.hold) {
            hold = true
            say(`held: ${name} stays off this machine until the operator re-admits it with the add-skill skill`)
          }
        }
        if (row.assessment?.rulesCommit && !gitOk(git, ['diff', '--quiet', row.assessment.rulesCommit, 'HEAD', '--', ...RULES])) {
          say(`warn: ${name}: ${RULES.join(' or ')} changed since its assessment; re-run the add-skill skill's assessment on it`)
        }
        if (hold) {
          if (present(name) && owned(name)) act(`remove skill ${name}, held by its audit`, () => remove(name))
        } else if (!present(name)) act(`add skill ${name} at ${row.commit}`, () => add(name, row))
        else if (owned(name) && lock[name].ref !== row.commit) {
          act(`move skill ${name} from ${lock[name].ref} to ${row.commit}`, () => { remove(name); add(name, row) })
        }
      }
      for (const name of unwanted) act(`remove skill ${name}, which installedSkills no longer names`, () => remove(name))
    } finally {
      rmSync(stub, { recursive: true, force: true })
    }
  }
  const exclude = excludeFile(root, names)
  if (exclude.changed) act('update the installed skills in info/exclude', () => writeFileSync(exclude.path, exclude.next))

  for (const failure of failures) say(`fail: ${failure}`)
  return failures.length && !warnOnly ? 1 : 0
}

/** The admission's deterministic pass: each command in a skill's shell code blocks, through the repository's command guards. */
export function scan(dir, root = SCRIPT_ROOT) {
  const guards = JSON.parse(readFileSync(join(root, '.harness/hooks.json'), 'utf8')).hooks
    .filter((group) => group.event === 'before-command').flatMap((group) => group.handlers.map((h) => h.script))
  const findings = []
  const walk = (at) => readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? walk(join(at, name)) : [join(at, name)]))
  for (const file of walk(dir).filter((f) => f.endsWith('.md'))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let shell = null
    lines.forEach((line, index) => {
      const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(line)
      if (fence) { shell = shell === null ? ['', 'sh', 'bash', 'shell', 'console', 'zsh'].includes(fence[2]) : null; return }
      const command = line.trim().replace(/^\$\s+/, '')
      if (!shell || command === '' || command.startsWith('#')) return
      for (const guard of guards) {
        const result = spawnSync(process.execPath, [join(root, guard)], {
          cwd: root, env: { ...gitEnv(), CLAUDE_PROJECT_DIR: root }, encoding: 'utf8',
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } }),
        })
        if (result.status === 2) findings.push(`${relative(dir, file)}:${index + 1}: ${guard} refuses \`${command}\`: ${result.stderr.trim().split('\n')[0]}`)
      }
    })
  }
  return findings
}

/** Copy each installed skill from the primary checkout into a new worktree; a held skill is absent there, so it is not copied. */
export function copy(worktree, from = SCRIPT_ROOT) {
  const root = primaryCheckout(from)
  const git = gitIn(root)
  const copied = []
  for (const name of Object.keys(lists(root).skills).filter((n) => NAME.test(n))) {
    const source = join(root, '.claude/skills', name)
    const target = join(worktree, '.claude/skills', name)
    if (!existsSync(join(source, 'SKILL.md')) || existsSync(target) || git(['ls-files', '--', `.claude/skills/${name}`]).trim()) continue
    cpSync(source, target, { recursive: true })
    copied.push(name)
  }
  return copied
}

async function main(argv) {
  const [mode, ...rest] = argv
  const flag = (name) => rest.includes(name)
  if (mode === 'check') {
    const problems = check(SCRIPT_ROOT)
    if (!problems.length) return void console.log('skills:check: policy/skill-sources.json holds every rule its gatedBy names.')
    console.error(`skills:check: ${problems.length} problem(s).\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exitCode = 1
  } else if (mode === 'sync') {
    const at = rest.indexOf('--since')
    try {
      process.exitCode = await sync({
        dryRun: flag('--dry-run'), warnOnly: flag('--warn-only'), ownsUserConfig: flag('--owns-user-config'),
        since: at >= 0 ? rest[at + 1] ?? '' : null,
      })
    } catch (error) {
      console.log(`fail: ${error.message}`)
      process.exitCode = flag('--warn-only') ? 0 : 1
    }
  } else if (mode === 'audit' && rest.length === 2) {
    const audit = await readAudit(rest[0], rest[1])
    if (audit.error) {
      console.log(`finding: ${audit.error}; no audit can be read, so the skill would be admitted unaudited`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(audit.results, null, 2))
    const flagged = Object.entries(audit.results).filter(([, a]) => a.status !== 'pass')
    for (const [slug, a] of flagged) console.log(`finding: ${slug} ${brief(a)}`)
    if (flagged.length) process.exitCode = 1
  } else if (mode === 'scan' && rest.length === 1) {
    const findings = scan(resolve(rest[0]))
    for (const finding of findings) console.log(`finding: ${finding}`)
    if (findings.length) process.exitCode = 1
  } else if (mode === 'copy' && rest.length === 1) {
    for (const name of copy(resolve(rest[0]))) console.log(`copied installed skill ${name} into ${rest[0]}`)
  } else if (mode === '--selftest') {
    await selftest()
  } else {
    console.error('usage: node scripts/skill-sources.mjs check | sync [--dry-run] [--warn-only] [--owns-user-config] [--since <rev>] | audit <owner>/<repo> <skill> | scan <dir> | copy <worktree> | --selftest')
    process.exitCode = 2
  }
}

// ---- selftest ---------------------------------------------------------------------------------

const PIN = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const PASS = { 'agent-trust-hub': { status: 'pass', riskLevel: 'SAFE' }, snyk: { status: 'warn', riskLevel: 'MEDIUM' } }

const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const file = process.env.STUB_STATE, state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2), line = args.join(' ')
fs.appendFileSync(process.env.STUB_LOG, 'claude ' + line + '\\n')
if (state.fail && line.includes(state.fail)) { console.error('stub failure'); process.exit(1) }
if (line === 'plugin marketplace list --json') console.log(JSON.stringify(state.markets.map((name) => ({ name }))))
else if (line === 'plugin list --json') console.log(JSON.stringify(state.plugins))
else if (args[1] === 'install') {
  state.plugins.push({ id: args[2], scope: 'project', projectPath: process.cwd() })
  if (state.editSettings) fs.appendFileSync(path.join(process.cwd(), '.claude/settings.json'), ' ')
} else if (args[1] === 'uninstall') {
  state.plugins = state.plugins.filter((p) => !(p.id === args[2] && p.projectPath === process.cwd()))
  if (state.editSettings) fs.appendFileSync(path.join(process.cwd(), '.claude/settings.json'), ' ')
} else if (args[2] === 'add') state.markets.push(path.basename(args[3]).replace(/\\.git#.*/, ''))
else if (args[2] === 'remove') state.markets = state.markets.filter((m) => m !== args[3])
fs.writeFileSync(file, JSON.stringify(state))
`

const STUB_SKILLS = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'))
const args = process.argv.slice(2), name = args[args.indexOf('-s') + 1]
const gh = spawnSync('gh', ['auth', 'token'], { shell: process.platform === 'win32' }).status
const env = (process.env.DISABLE_TELEMETRY === '1' ? '' : ' TELEMETRY') + (process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? ' TOKEN' : '') + (gh === 0 ? ' GH' : '')
fs.appendFileSync(process.env.STUB_LOG, 'skills ' + args.join(' ') + env + '\\n')
const lockFile = path.join(process.cwd(), 'skills-lock.json')
const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { version: 1, skills: {} }
const dir = path.join(process.cwd(), '.claude/skills', name)
if (args[0] === 'add' && !state.skillsWriteNothing) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\\nname: ' + name + '\\n---\\n')
  const [source, ref] = args[1].split('#')
  lock.skills[name] = { source, ref, sourceType: 'github', computedHash: 'x' }
}
if (args[0] === 'remove' && !state.skillsRemoveNothing) { fs.rmSync(dir, { recursive: true, force: true }); delete lock.skills[name] }
fs.writeFileSync(lockFile, JSON.stringify(lock))
`

/** Run this script as a child, asynchronously, so the stub skills.sh in this process can answer it. */
function child(args, { cwd, env }) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, args, { cwd, env })
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (out += d))
    proc.on('close', (status) => done({ status, out }))
  })
}

async function selftest() {
  const { test, after } = await import('node:test')
  const assert = (await import('node:assert/strict')).default
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'skill-sources-selftest-')))
  const audits = new Map()
  const server = createServer((request, response) => {
    const answer = audits.get(request.url) ?? { status: 404 }
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer.body ?? {}))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  after(() => { server.close(); rmSync(temp, { recursive: true, force: true }) })
  const auditUrl = `http://127.0.0.1:${server.address().port}`
  let count = 0
  const scratchGit = (root) => gitIn(root, { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' })

  /** A scratch primary checkout holding this script, the policy, a tracked skill and stubs, in sync with `edit`'s record. */
  function fixture({ edit = () => {}, state = {}, audit = PASS } = {}) {
    const root = join(temp, `case-${++count}`)
    for (const file of ['scripts/skill-sources.mjs', 'tools/lib/policy.ts', 'tools/lib/git-env.ts', '.harness/hooks.json', '.harness/agents/skill-assessor.md']) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      cpSync(join(SCRIPT_ROOT, file), join(root, file))
    }
    cpSync(join(SCRIPT_ROOT, 'scripts/hooks'), join(root, 'scripts/hooks'), { recursive: true })
    copyPolicy(SCRIPT_ROOT, root)
    writeFileSync(join(root, 'mise.toml'), '[tools]\n"github:example/cli" = "1.2.3"\n')
    writeFileSync(join(root, 'AGENTS.md'), 'rules\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
    for (const dir of ['.harness/skills/tracked', '.claude/skills/tracked']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'SKILL.md'), '---\nname: tracked\n---\n')
    }
    writeFileSync(join(root, '.claude/settings.json'), '{}\n')
    const git = scratchGit(root)
    git(['init', '--quiet', '--initial-branch=main'])
    git(['add', '--all'])
    git(['commit', '--quiet', '-m', 'fixture'])
    const rules = git(['rev-parse', 'HEAD']).trim()
    editPolicy(root, (c) => {
      c.claudeEnabledPlugins = ['tool@market']
      c.claudePluginMarketplaces = { market: { source: 'example/cli#v1.2.3', heldTo: 'github:example/cli', means: 'fixture' } }
      c.installedSkills = { helper: { source: 'example/skills', commit: PIN, reason: 'fixture', assessment: { commit: PIN, rulesCommit: rules, findings: 0, issue: 'fx-1' }, audit: PASS } }
      edit(c, rules)
    })
    git(['add', '--all'])
    git(['commit', '--quiet', '-m', 'policy'])
    const bin = join(root, 'stub-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), STUB_CLAUDE, { mode: 0o755 })
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho credentialed-token\n', { mode: 0o755 })
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules/.bin/skills'), STUB_SKILLS, { mode: 0o755 })
    writeFileSync(join(root, 'stub-bin/.gitignore'), '*\n')
    // In sync already: the plugin installed for this clone, the skill installed at its pin, and
    // records the sync must leave (another clone's, a user-scope one).
    const initial = {
      markets: ['market'],
      plugins: [
        { id: 'tool@market', scope: 'project', projectPath: root },
        { id: 'other@market', scope: 'project', projectPath: join(temp, 'elsewhere') },
        { id: 'mine@market', scope: 'user' },
      ],
      ...state,
    }
    writeFileSync(join(root, 'stub-bin/state.json'), JSON.stringify(initial))
    if (!state.skipInstall) {
      mkdirSync(join(root, '.claude/skills/helper'), { recursive: true })
      writeFileSync(join(root, '.claude/skills/helper/SKILL.md'), '---\nname: helper\n---\n')
      writeFileSync(join(root, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { helper: { source: 'example/skills', ref: PIN }, ...state.lock } }))
      const exclude = excludeFile(root, ['helper'])
      writeFileSync(exclude.path, exclude.next)
    }
    audits.set(`/example/skills/helper`, typeof audit === 'number' ? { status: audit } : { status: 200, body: { audits: Object.entries(audit).map(([slug, a]) => ({ slug, ...a })) } })
    const env = {
      ...gitEnv(), PATH: bin + delimiter + process.env.PATH, STUB_STATE: join(bin, 'state.json'), STUB_LOG: join(bin, 'log'),
      SKILLS_AUDIT_URL: auditUrl, GH_TOKEN: 'leaked-token',
    }
    writeFileSync(env.STUB_LOG, '')
    return {
      root, git, rules,
      sync: (...args) => child([join(root, 'scripts/skill-sources.mjs'), 'sync', ...args], { cwd: root, env }),
      run: (...args) => child([join(root, 'scripts/skill-sources.mjs'), ...args], { cwd: root, env }),
      log: () => readFileSync(env.STUB_LOG, 'utf8'),
      state: () => JSON.parse(readFileSync(env.STUB_STATE, 'utf8')),
      env,
    }
  }

  // The committed-files check.
  const checkCase = (name, edit, reason) => test(`check ${name}`, () => {
    const { root } = fixture({ edit })
    const problems = check(root)
    if (reason) assert.match(problems.join('\n'), reason)
    else assert.deepEqual(problems, [])
  })
  checkCase('control: a plugin, its held marketplace and an admitted skill hold', () => {})
  checkCase('refuses an enabled plugin whose marketplace has no source', (c) => c.claudeEnabledPlugins.push('x@nowhere'), /its marketplace nowhere has no row/)
  checkCase('refuses a source with no tag', (c) => { c.claudePluginMarketplaces.market.source = 'example/cli' }, /is not <owner>\/<repo>#<tag>/)
  checkCase('refuses a tag that differs from its held mise pin', (c) => { c.claudePluginMarketplaces.market.source = 'example/cli#v1.2.4' }, /tag v1\.2\.4 differs from the mise pin of github:example\/cli, 1\.2\.3/)
  checkCase('refuses a marketplace no enabled plugin uses', (c) => { c.claudePluginMarketplaces.spare = { source: 'a/b#1', means: 'x' } }, /marketplace spare: no enabled plugin uses it/)
  checkCase('refuses an installed skill with no full commit', (c) => { c.installedSkills.helper.commit = 'abc123' }, /commit is not a full 40-character SHA/)
  checkCase('refuses an installed skill with no reason', (c) => { delete c.installedSkills.helper.reason }, /installed skill helper: no reason/)
  checkCase('refuses an installed skill whose name a tracked skill holds', (c) => { c.installedSkills.tracked = { ...c.installedSkills.helper } }, /tracked skill under \.harness\/skills\/ already holds that name/)
  checkCase('refuses an assessment of another commit than the pin', (c) => { c.installedSkills.helper.commit = MOVED }, /its assessment read a{40}, not its pin/)
  checkCase('refuses findings that name no issue', (c) => { delete c.installedSkills.helper.assessment.issue }, /found something, and it names no issue/)
  checkCase('refuses an unaudited skill that names no issue', (c) => { c.installedSkills.helper.audit = {}; delete c.installedSkills.helper.assessment.issue }, /names no issue/)
  test('check refuses an assessor given a tool that acts', () => {
    const { root } = fixture()
    const file = join(root, '.harness/agents/skill-assessor.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^tools:.*$/m, 'tools: Read, Grep, Glob, Bash'))
    assert.match(check(root).join('\n'), /skill-assessor\.md: its tools are "Read, Grep, Glob, Bash", not Read, Grep, Glob/)
  })
  checkCase('refuses a skill name that is not a directory name', (c) => { c.installedSkills['../escape'] = c.installedSkills.helper }, /not a skill directory name/)

  // The sync, one case per row of the plan's table and per rule.
  test('sync control: a machine in sync gets no action, from the run or its dry run, and the record entries it does not own stay', async () => {
    const f = fixture()
    for (const args of [[], ['--dry-run']]) {
      const r = await f.sync(...args)
      assert.equal(r.status, 0, r.out)
      assert.equal(r.out, '')
    }
    assert.match(f.log(), /^claude plugin list --json$/m, 'the sync never asked claude, so it never ran')
    assert.doesNotMatch(f.log(), /install|uninstall|add|remove/)
  })
  test('sync adds an enabled plugin\'s unregistered marketplace at its tag', async () => {
    const f = fixture({ state: { markets: [] } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), /claude plugin marketplace add https:\/\/github\.com\/example\/cli\.git#v1\.2\.3/)
  })
  test('sync installs an enabled plugin with no project record for this clone, without -y', async () => {
    const f = fixture({ state: { plugins: [] } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), /^claude plugin install tool@market --scope project$/m)
  })
  test('sync uninstalls this clone\'s record of a plugin no longer enabled, and leaves other clones\' and user records', async () => {
    const f = fixture({ edit: (c) => { c.claudeEnabledPlugins = []; c.claudePluginMarketplaces = {} } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), /^claude plugin uninstall tool@market --scope project$/m)
    assert.doesNotMatch(f.log(), /uninstall (other|mine)@market/)
  })
  test('sync fails when an install leaves .claude/settings.json changed', async () => {
    const f = fixture({ state: { plugins: [], editSettings: true } })
    const r = await f.sync()
    assert.equal(r.status, 1)
    assert.match(r.out, /fail: install plugin tool@market .*the install edited \.claude\/settings\.json/)
  })
  test('sync fails when an uninstall leaves .claude/settings.json changed', async () => {
    const f = fixture({ edit: (c) => { c.claudeEnabledPlugins = []; c.claudePluginMarketplaces = {} }, state: { editSettings: true } })
    const r = await f.sync()
    assert.equal(r.status, 1)
    assert.match(r.out, /fail: .*edited \.claude\/settings\.json/)
  })
  test('sync prints and leaves an unused marketplace on the host, and removes it where it owns the config directory', async () => {
    const host = fixture({ state: { markets: ['market', 'spare'] } })
    const r = await host.sync()
    assert.match(r.out, /note: marketplace spare is registered/)
    assert.deepEqual(host.state().markets, ['market', 'spare'])
    const container = fixture({ state: { markets: ['market', 'spare'] } })
    assert.equal((await container.sync('--owns-user-config')).status, 0)
    assert.deepEqual(container.state().markets, ['market'])
  })
  test('sync adds a missing skill at its pin with telemetry off, no token and a withheld gh, and hides it from git', async () => {
    const f = fixture({ state: { skipInstall: true } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), new RegExp(`^skills add example/skills#${PIN} -a claude-code -s helper --copy -y$`, 'm'))
    assert.ok(existsSync(join(f.root, '.claude/skills/helper/SKILL.md')))
    assert.equal(f.git(['status', '--porcelain']).trim(), '', 'the installed skill shows in git status')
  })
  test('sync fails when skills add exits 0 and writes no SKILL.md', async () => {
    const f = fixture({ state: { skipInstall: true, skillsWriteNothing: true } })
    const r = await f.sync()
    assert.equal(r.status, 1)
    assert.match(r.out, /wrote no \.claude\/skills\/helper\/SKILL\.md/)
  })
  test('sync holds a skill whose audit worsened to fail, and removes it', async () => {
    const f = fixture({ audit: { ...PASS, socket: { status: 'fail' } } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /held: helper: socket is now fail, accepted never seen/)
    assert.ok(!existsSync(join(f.root, '.claude/skills/helper')))
  })
  test('sync holds a missing skill whose risk rose to HIGH, and installs nothing', async () => {
    const f = fixture({ state: { skipInstall: true }, audit: { ...PASS, snyk: { status: 'warn', riskLevel: 'HIGH' } } })
    const r = await f.sync()
    assert.match(r.out, /held: helper: snyk is now warn HIGH, accepted warn MEDIUM/)
    assert.doesNotMatch(f.log(), /skills add/)
  })
  test('sync warns on a lesser worsening and installs the skill all the same', async () => {
    const f = fixture({ state: { skipInstall: true }, audit: { ...PASS, 'agent-trust-hub': { status: 'warn', riskLevel: 'LOW' } } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /warn: helper: agent-trust-hub is now warn LOW, accepted pass SAFE/)
    assert.match(f.log(), /skills add/)
  })
  test('sync keeps the accepted audit when skills.sh cannot be read', async () => {
    const f = fixture({ state: { skipInstall: true }, audit: 500 })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /warn: helper: skills\.sh answered 500; the accepted audit stands/)
    assert.match(f.log(), /skills add/)
  })
  test('sync moves a skill whose pin moved: remove, then add at the new pin', async () => {
    const f = fixture({ edit: (c) => { c.installedSkills.helper.commit = MOVED; c.installedSkills.helper.assessment.commit = MOVED } })
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), new RegExp(`skills remove -a claude-code -s helper -y\\nskills add example/skills#${MOVED} `))
  })
  test('sync removes a skill the lock records and the table no longer names, and leaves a tracked one', async () => {
    const f = fixture({ state: { lock: { stale: { source: 'x/y', ref: PIN }, tracked: { source: 'x/y', ref: PIN } } } })
    mkdirSync(join(f.root, '.claude/skills/stale'))
    writeFileSync(join(f.root, '.claude/skills/stale/SKILL.md'), 'x')
    const r = await f.sync()
    assert.equal(r.status, 0, r.out)
    assert.match(f.log(), /skills remove -a claude-code -s stale -y/)
    assert.doesNotMatch(f.log(), /-s tracked/)
    assert.ok(existsSync(join(f.root, '.claude/skills/tracked/SKILL.md')))
  })
  test('sync fails when skills remove exits 0 and leaves the directory', async () => {
    const f = fixture({ state: { lock: { stale: { source: 'x/y', ref: PIN } }, skillsRemoveNothing: true } })
    mkdirSync(join(f.root, '.claude/skills/stale'))
    const r = await f.sync()
    assert.equal(r.status, 1)
    assert.match(r.out, /skills remove exited 0 and left \.claude\/skills\/stale\//)
  })
  test('sync skips with its reason when claude and the skills CLI are absent', async () => {
    const f = fixture({ state: { skipInstall: true } })
    rmSync(join(f.root, 'stub-bin/claude'))
    rmSync(join(f.root, 'node_modules'), { recursive: true })
    const r = await child([join(f.root, 'scripts/skill-sources.mjs'), 'sync'], { cwd: f.root, env: { ...f.env, PATH: join(f.root, 'stub-bin') + delimiter + dirname(process.execPath) + delimiter + '/usr/bin:/bin' } })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /skip: claude not found/)
    assert.match(r.out, /skip: node_modules\/\.bin\/skills not found/)
  })
  test('sync fails when a found tool fails, and --warn-only prints the failure and exits 0', async () => {
    const f = fixture({ state: { plugins: [], fail: 'plugin install' } })
    const r = await f.sync()
    assert.equal(r.status, 1)
    assert.match(r.out, /fail: install plugin tool@market for this clone: .*exited 1/)
    const w = await f.sync('--warn-only')
    assert.equal(w.status, 0)
    assert.match(w.out, /fail: install plugin/)
  })
  test('sync --dry-run prints each action and changes nothing', async () => {
    const f = fixture({ state: { plugins: [], markets: [], skipInstall: true } })
    const r = await f.sync('--dry-run')
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /would add marketplace market/)
    assert.match(r.out, /would install plugin tool@market/)
    assert.match(r.out, /would add skill helper/)
    assert.doesNotMatch(f.log(), /install|skills add/)
  })
  test('sync warns when AGENTS.md changed after the assessment, and still installs', async () => {
    const f = fixture({ state: { skipInstall: true } })
    writeFileSync(join(f.root, 'AGENTS.md'), 'new rule\n')
    f.git(['commit', '--quiet', '-am', 'new rule'])
    const r = await f.sync()
    assert.match(r.out, /warn: helper: AGENTS\.md or CLAUDE\.md changed since its assessment/)
    assert.match(f.log(), /skills add/)
  })
  test('sync --since does nothing when the lists did not change, or the old head is null, and runs when they did', async () => {
    const f = fixture({ state: { plugins: [] } })
    const head = f.git(['rev-parse', 'HEAD']).trim()
    for (const since of [head, '0'.repeat(40)]) {
      assert.equal((await f.sync('--since', since)).out, '')
    }
    assert.match((await f.sync('--since', 'HEAD~1')).out, /install plugin tool@market/)
  })
  test('sync from a linked worktree acts for the primary checkout', async () => {
    const f = fixture({ state: { plugins: [] } })
    const worktree = join(temp, `worktree-${count}`)
    f.git(['worktree', 'add', '--quiet', '-b', 'agent/x', worktree])
    const r = await child([join(worktree, 'scripts/skill-sources.mjs'), 'sync'], { cwd: worktree, env: f.env })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(f.state().plugins.filter((p) => p.id === 'tool@market').map((p) => p.projectPath), [f.root])
  })

  // Admission's deterministic pass, the audit reader, and the worktree copy.
  test('scan refuses a code-block command a guard refuses, and passes prose and allowed commands', async () => {
    const f = fixture()
    const skill = join(f.root, 'candidate')
    mkdirSync(skill)
    writeFileSync(join(skill, 'SKILL.md'), 'Run gh pr create in prose.\n\n```sh\ngit status\n$ gh pr create --title x --body y\n```\n\n```js\ngh pr create\n```\n')
    const findings = scan(skill, f.root)
    assert.equal(findings.length, 1, findings.join('\n'))
    assert.match(findings[0], /^SKILL\.md:5: scripts\/hooks\/guard-git\.mjs refuses `gh pr create --title x --body y`/)
  })
  test('audit names each provider result other than pass, and a missing audit, as findings', async () => {
    const f = fixture()
    const r = await f.run('audit', 'example/skills', 'helper')
    assert.equal(r.status, 1)
    assert.match(r.out, /finding: snyk warn MEDIUM/)
    const missing = await f.run('audit', 'example/skills', 'unaudited')
    assert.match(missing.out, /finding: skills\.sh answered 404/)
  })
  test('copy puts each installed skill into a new worktree, and no tracked or absent one', async () => {
    const f = fixture()
    const worktree = join(temp, `worktree-${count}`)
    f.git(['worktree', 'add', '--quiet', '-b', 'agent/y', worktree])
    const r = await f.run('copy', worktree)
    assert.equal(r.status, 0, r.out)
    assert.ok(existsSync(join(worktree, '.claude/skills/helper/SKILL.md')))
    assert.equal(scratchGit(worktree)(['status', '--porcelain']).trim(), '', 'the copied skill shows in the worktree\'s git status')
  })
  test('the live record holds', () => assert.deepEqual(check(SCRIPT_ROOT), []))
}

if (process.argv[1] && realpathSync(process.argv[1]) === SELF) await main(process.argv.slice(2))

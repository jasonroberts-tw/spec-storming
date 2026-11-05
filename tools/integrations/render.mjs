/**
 * Render selected CLI integrations from the hand-maintained .harness definitions in memory.
 *
 * A second, independently maintained set of prompts drifts; copying Claude settings into another
 * CLI can silently disable guards. This renderer shares the content and delegates native formats.
 *
 *   renderIntegrations({ root, integrations: ['claude', 'codex'] })
 *
 * Reads only the Template or Target project's definitions and hook scripts. No npm, CLI, or network.
 * KIND: deterministic integration emitter, separate from writing its result.
 * INVARIANTS: no writes; unknown selections, source shapes, and CLI placeholders fail.
 * RE-ENTRY: identical sources and selections yield byte-identical output; the CLI offers --check.
 * STALE WHEN: .harness sources, policy `claudeEnabledPlugins`, or tools/integrations adapter code changes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapters, renderCliText, selectIntegrations } from './adapters.mjs'
import { compare, generatedMarkdown, markdown } from './formats.mjs'
import { readPolicy, recordPaths } from '../lib/policy.ts'

export const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVENTS = new Set(['before-command', 'before-edit', 'worktree-create', 'worktree-remove'])

function filesUnder(root, prefix) {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const file = prefix + '/' + entry.name
      if (entry.isSymbolicLink()) throw new Error('Symlink in integration source: ' + file)
      if (entry.isDirectory()) return filesUnder(root, file)
      if (!entry.isFile()) throw new Error('Non-file integration source: ' + file)
      return [file]
    })
}

function hookGroups(root) {
  const { hooks } = JSON.parse(readFileSync(join(root, '.harness/hooks.json'), 'utf8'))
  if (!Array.isArray(hooks)) throw new Error('Expected hooks array in .harness/hooks.json')
  for (const group of hooks) {
    if (!EVENTS.has(group.event) || !Array.isArray(group.handlers) || !group.handlers.length) {
      throw new Error('Invalid logical hook event or handlers: ' + group.event)
    }
    for (const handler of group.handlers) {
      if (!/^scripts\/hooks\/[a-z0-9-]+\.mjs$/.test(handler.script) ||
          !Number.isSafeInteger(handler.timeout) || handler.timeout <= 0 ||
          typeof handler.statusMessage !== 'string' || !handler.statusMessage.trim()) {
        throw new Error('Invalid hook handler: ' + JSON.stringify(handler))
      }
      if (!statSync(join(root, handler.script)).isFile()) throw new Error('Hook script is not a file: ' + handler.script)
    }
  }
  return hooks
}

/** Returns native strings or asset Buffers, source asset modes, and capability warnings. */
export function renderIntegrations({ root = TEMPLATE_ROOT, integrations } = {}) {
  const selected = selectIntegrations(integrations)
  const files = new Map()
  const modes = new Map()
  const warnings = []
  const groups = hookGroups(root)
  const plugins = (recordPaths(root).length ? readPolicy(root).claudeEnabledPlugins : undefined) ?? []
  if (!Array.isArray(plugins) || plugins.some((id) => typeof id !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(id))) {
    throw new Error('Invalid policy claudeEnabledPlugins: ' + JSON.stringify(plugins))
  }
  const skills = filesUnder(root, '.harness/skills')
  const agents = filesUnder(root, '.harness/agents').filter((file) => file.endsWith('.md') && !file.endsWith('/README.md'))
  for (const id of selected) {
    const adapter = adapters[id]
    for (const file of skills) {
      if (file === '.harness/skills/README.md') continue
      const output = adapter.skillDirectory + file.slice('.harness/skills'.length)
      modes.set(output, statSync(join(root, file)).mode & 0o777)
      const source = readFileSync(join(root, file))
      if (file.endsWith('/SKILL.md')) {
        const text = renderCliText(source.toString('utf8'), id)
        const skill = markdown(text, file)
        if (skill.name !== file.split('/').at(-2)) throw new Error('Skill name does not match directory: ' + file)
        files.set(output, generatedMarkdown(text, file))
      } else {
        files.set(output, file.endsWith('.md') ? renderCliText(source.toString('utf8'), id) : source)
      }
    }
    for (const file of agents) {
      const text = renderCliText(readFileSync(join(root, file), 'utf8'), id)
      const agent = markdown(text, file)
      if (file.split('/').at(-1) !== agent.name + '.md') throw new Error('Agent name does not match filename: ' + file)
      files.set(...adapter.agent(agent, text, file))
    }
    for (const [source, output] of Object.entries(adapter.entryPoints)) {
      files.set(output, renderCliText(readFileSync(join(root, source), 'utf8'), id))
    }
    const hooks = adapter.hooks(groups, plugins)
    for (const [file, contents] of hooks.files ?? [[hooks.file, hooks.contents]]) files.set(file, contents)
    warnings.push(...hooks.warnings)
  }
  return { integrations: selected, files: new Map([...files].sort(([a], [b]) => compare(a, b))), modes, warnings }
}

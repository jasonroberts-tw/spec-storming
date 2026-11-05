/** OpenCode's native skills, agents, and plugins that run the hook scripts, for OpenCode 1 and 2;
 * prevents Claude-shaped inert config. Called by renderIntegrations. Formats follow the official
 * references in .harness/README.md. Needs no CLI or network. Worktree lifecycle events are explicitly
 * reported as unsupported.
 */
import { generated, generatedJs, quote } from './formats.mjs'

// OpenCode's permission keys for Claude's tool names. Its `edit` permission covers write too.
const permissions = {
  Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'edit', Grep: 'grep', Glob: 'glob',
  Task: 'task', WebFetch: 'webfetch', WebSearch: 'websearch', TodoWrite: 'todowrite',
}

// OpenCode reads `tools` only as a map of booleans, so a Claude tool list becomes permission rules.
// The last matching rule wins, so the catch-all deny comes first.
function permission(tools, file) {
  const allowed = new Set(tools.split(',').map((name) => {
    if (!Object.hasOwn(permissions, name.trim())) throw new Error('No OpenCode permission for agent tool ' + name.trim() + ': ' + file)
    return permissions[name.trim()]
  }))
  return 'permission:\n  "*": deny\n' + [...allowed].map((key) => '  ' + key + ': allow\n').join('')
}

// OpenCode runs no hook commands. A plugin sees each tool call first, with OpenCode's tool IDs and
// argument names, so the plugin hands each script the Claude payload it reads. Only the export that
// OpenCode loads differs between versions.
const plugin = (hooks, { root, imports, exports }) => generatedJs + `/**
 * Runs the harness hook scripts before OpenCode's tool calls, as Claude runs its PreToolUse hooks.
 * Each script reads a Claude payload on stdin. Exit 2 refuses the call, with the script's stderr as
 * the reason; any other exit lets it run, as in Claude.
 */
${imports}import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
// The checkout that holds the hook scripts, from this file's place in it.
const ROOT = resolve(dirname(SELF), '${root}')
const HOOKS = ${JSON.stringify(hooks)}

/**
 * Whether this checkout is the nearest one above the session's directory that holds this plugin.
 * A worktree under .opencode/worktrees/ holds its own copy, and OpenCode 2 loads every copy above
 * the session, so only the nearest one judges its calls.
 */
function owns(directory) {
  for (let dir = resolve(directory); ; dir = dirname(dir)) {
    if (existsSync(join(dir, relative(ROOT, SELF)))) return realpathSync(dir) === realpathSync(ROOT)
    if (dirname(dir) === dir) return false
  }
}

/**
 * The logical event and Claude payload for an OpenCode tool call, or null for a tool no hook judges.
 * OpenCode 1 names its tools bash and apply_patch, and a file filePath; OpenCode 2 names them shell
 * and patch, and a file path.
 */
function claudeCall(tool, args, cwd) {
  const path = args.filePath ?? args.path
  const file = typeof path === 'string' ? resolve(cwd, path) : path
  switch (tool) {
    case 'bash':
    case 'shell':
      return ['before-command', { cwd: typeof args.workdir === 'string' ? resolve(cwd, args.workdir) : cwd, tool_name: 'Bash', tool_input: { command: args.command } }]
    case 'write':
      return ['before-edit', { cwd, tool_name: 'Write', tool_input: { file_path: file, content: args.content } }]
    case 'edit':
      return ['before-edit', { cwd, tool_name: 'Edit', tool_input: { file_path: file, old_string: args.oldString, new_string: args.newString, replace_all: args.replaceAll } }]
    case 'apply_patch':
    case 'patch':
      return ['before-edit', { cwd, tool_name: 'apply_patch', tool_input: { command: args.patchText } }]
    default:
      return null
  }
}

/** A check of one tool call in the session at directory; it throws the reason a hook refuses the call. */
function guardFor(directory) {
  if (!owns(directory)) return () => {}
  return (tool, args) => {
    const call = claudeCall(tool, args ?? {}, directory)
    if (call === null) return
    for (const { script, timeout } of HOOKS[call[0]] ?? []) {
      const run = spawnSync('node', [resolve(ROOT, script)], { input: JSON.stringify(call[1]), encoding: 'utf8', timeout: timeout * 1000 })
      if (run.status === 2) throw new Error(run.stderr.trim() || script + ' refused this call')
    }
  }
}

${exports}`

// OpenCode 1 loads each .js file in .opencode/plugins/, and every export of one must be a plugin
// function. OpenCode 2 also loads a directory there, and only a module whose default export is
// `{ id, setup }`. So OpenCode 2's plugin is a directory, which OpenCode 1 never sees. OpenCode 2
// lists OpenCode 1's file as a plugin that failed to load.
const versions = {
  '.opencode/plugins/harness.js': {
    root: '../..',
    imports: '',
    exports: `export const HarnessHooks = async ({ directory }) => {
  const guard = guardFor(directory)
  return { 'tool.execute.before': async (input, output) => guard(input.tool, output.args) }
}
`,
  },
  // OpenCode 2 stops activating plugins when two share an id, and it loads the copy in each checkout
  // above the session, so the id names the checkout.
  '.opencode/plugins/harness-v2/server.js': {
    root: '../../..',
    imports: "import { createHash } from 'node:crypto'\n",
    exports: `export default {
  id: 'harness-hooks-' + createHash('sha256').update(ROOT).digest('hex').slice(0, 12),
  setup: async (ctx) => {
    const guard = guardFor(ctx.location.directory)
    await ctx.tool.hook('execute.before', (event) => guard(event.tool, event.input))
  },
}
`,
  },
}

export const opencode = {
  id: 'opencode',
  outputPaths: ['.opencode/skills/', '.opencode/agents/', ...Object.keys(versions)],
  // OpenCode also reads .claude/skills and .agents/skills.
  skillDirectory: '.opencode/skills',
  entryPoints: {},
  replacements: {
    CLI_WORKTREE_CREATE: 'HARNESS_CLI=opencode bash "$(git rev-parse --show-toplevel)/scripts/new-worktree.sh" <task-ref> <slug>',
    CLI_WORKTREE_REMOVE: 'end the worktree session, then run `git worktree remove <path>` from the primary checkout',
    CLI_WORKTREE_ISOLATION: '',
  },
  // OpenCode names an agent by its file. It would send a frontmatter key it does not know to the
  // model provider, so only `description` and `permission` are written.
  agent(agent, source, file) {
    const header = 'description: ' + quote(agent.description) + '\n' + (agent.tools === undefined ? '' : permission(agent.tools, file))
    return ['.opencode/agents/' + agent.name + '.md', '---\n' + header + '---\n\n' + generated + '\n\n' + agent.body]
  },
  hooks(groups) {
    const hooks = {}
    const warnings = []
    for (const group of groups) {
      if (group.event !== 'before-command' && group.event !== 'before-edit') {
        warnings.push('opencode: unsupported ' + group.event + ' hook; provision with scripts/new-worktree.sh and remove worktrees explicitly after work finishes.')
        continue
      }
      // OpenCode shows no status message for a plugin's check, so statusMessage has no place here.
      hooks[group.event] = [...(hooks[group.event] ?? []), ...group.handlers.map(({ script, timeout }) => ({ script, timeout }))]
    }
    return { files: Object.entries(versions).map(([file, version]) => [file, plugin(hooks, version)]), warnings }
  },
}

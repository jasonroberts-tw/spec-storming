/** Claude's native skill, agent, and hook formats; keeps Claude details out of shared definitions.
 * Called by renderIntegrations. Needs no CLI or network.
 */
import { generatedMarkdown, json } from './formats.mjs'

const events = {
  'before-command': { event: 'PreToolUse', matcher: 'Bash' },
  'before-edit': { event: 'PreToolUse', matcher: 'Write|Edit' },
  'worktree-create': { event: 'WorktreeCreate' },
  'worktree-remove': { event: 'WorktreeRemove' },
}

export const claude = {
  id: 'claude',
  outputPaths: ['.claude/', 'CLAUDE.md'],
  skillDirectory: '.claude/skills',
  entryPoints: {
    '.harness/CLAUDE.md': 'CLAUDE.md',
    '.harness/worktree-CONTEXT.md.tmpl': '.claude/worktree-CONTEXT.md.tmpl',
  },
  replacements: {
    CLI_WORKTREE_CREATE: 'EnterWorktree',
    CLI_WORKTREE_REMOVE: '`ExitWorktree`, action `remove`',
    CLI_WORKTREE_ISOLATION: "Claude Code's own worktree isolation refuses too (verified against the CLI, 2.1.292): a git command naming git twice, as in a file name, and a command such as \`bd\`, \`gh\` or \`docker exec\` whose text names git. Leave the word out where you can; a step that needs it is a person's (\`AGENTS.md\` § Guards).",
  },
  agent(agent, source, file) {
    return ['.claude/agents/' + agent.name + '.md', generatedMarkdown(source, file)]
  },
  hooks(groups, plugins = []) {
    const hooks = {}
    for (const group of groups) {
      const { event, ...match } = events[group.event]
      const entries = (hooks[event] ??= [])
      entries.push({
        ...match,
        hooks: group.handlers.map(({ script, timeout, statusMessage }) => ({
          type: 'command',
          // Copilot CLI runs this file's hooks too, and its docs name no CLAUDE_PROJECT_DIR; a
          // command that fails there denies the tool call, so git's root stands in for it.
          command: 'node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"/' + script,
          timeout,
          statusMessage,
        })),
      })
    }
    // enabledPlugins last: `claude plugin install --scope project` rewrites this file with it last
    // (2.1.296), so in any other place the sync's install would edit a rendered file.
    return { file: '.claude/settings.json', contents: json(plugins.length ? { hooks, enabledPlugins: Object.fromEntries(plugins.map((id) => [id, true])) } : { hooks }), warnings: [] }
  },
}

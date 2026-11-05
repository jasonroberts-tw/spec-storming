/** Codex's native skills, TOML agents, and command hooks; prevents Claude-shaped inert config.
 * Called by renderIntegrations. Formats follow the official references in .harness/README.md.
 * Needs no CLI or network. Worktree lifecycle events are explicitly reported as unsupported.
 */
import { generatedToml, quote } from './formats.mjs'

const events = {
  'before-command': { event: 'PreToolUse', matcher: 'Bash' },
  'before-edit': { event: 'PreToolUse', matcher: 'apply_patch' },
}

export const codex = {
  id: 'codex',
  outputPaths: ['.codex/', '.agents/'],
  skillDirectory: '.agents/skills',
  entryPoints: {},
  replacements: {
    CLI_WORKTREE_CREATE: 'HARNESS_CLI=codex bash "$(git rev-parse --show-toplevel)/scripts/new-worktree.sh" <task-ref> <slug>',
    CLI_WORKTREE_REMOVE: 'end the worktree session, then run `git worktree remove <path>` from the primary checkout',
    CLI_WORKTREE_ISOLATION: '',
  },
  agent(agent) {
    return [
      '.codex/agents/' + agent.name + '.toml',
      generatedToml +
        'name = ' + quote(agent.name) + '\n' +
        'description = ' + quote(agent.description) + '\n' +
        'developer_instructions = ' + quote(agent.body) + '\n',
    ]
  },
  hooks(groups) {
    let contents = generatedToml
    const warnings = []
    for (const group of groups) {
      const mapping = events[group.event]
      if (!mapping) {
        warnings.push('codex: unsupported ' + group.event + ' hook; provision with scripts/new-worktree.sh and remove worktrees explicitly after work finishes.')
        continue
      }
      contents += '\n[[hooks.' + mapping.event + ']]\nmatcher = ' + quote(mapping.matcher) + '\n'
      for (const { script, timeout, statusMessage } of group.handlers) {
        contents += '\n[[hooks.' + mapping.event + '.hooks]]\n' +
          'type = "command"\n' +
          'command = ' + quote('node "$(git rev-parse --show-toplevel)/' + script + '"') + '\n' +
          'timeout = ' + timeout + '\n' +
          'statusMessage = ' + quote(statusMessage) + '\n'
      }
    }
    return { file: '.codex/config.toml', contents, warnings }
  },
}

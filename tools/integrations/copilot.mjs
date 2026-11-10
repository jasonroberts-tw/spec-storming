/** GitHub Copilot's native skills, agents, and command hooks, for Copilot CLI and for VS Code;
 * prevents Claude-shaped inert config.
 * Called by renderIntegrations. Formats follow the official references in .harness/README.md.
 * Needs no CLI or network. Worktree lifecycle events are explicitly reported as unsupported.
 */
import { generatedMarkdown, json } from './formats.mjs'

// PascalCase `PreToolUse` selects Claude's payload and matcher names. Copilot CLI maps its own tools
// to them: bash and powershell to Bash, create to Write, edit and apply_patch to Edit. VS Code's
// Local agent reads this file too, but ignores `matcher` and sends its own tool names, so each hook
// script decides for itself which tools it judges.
const matchers = {
  'before-command': 'Bash',
  'before-edit': 'Write|Edit',
}

// Copilot's tool aliases for Claude's tool names. Copilot CLI accepts either, but VS Code maps
// Claude's names only for an agent under .claude/agents, and drops a name it does not know.
const toolAliases = {
  Bash: 'execute', Read: 'read', Edit: 'edit', Write: 'edit', Grep: 'search', Glob: 'search',
  Task: 'agent', WebFetch: 'web', WebSearch: 'web', TodoWrite: 'todo',
}

function copilotTools(tools, file) {
  return [...new Set(tools.split(',').map((name) => {
    if (!Object.hasOwn(toolAliases, name.trim())) throw new Error('No Copilot alias for agent tool ' + name.trim() + ': ' + file)
    return toolAliases[name.trim()]
  }))].join(', ')
}

export const copilot = {
  id: 'copilot',
  outputPaths: ['.github/skills/', '.github/agents/', '.github/hooks/harness.json'],
  // Copilot also reads .claude/skills and .agents/skills, but .github/skills wins a name both hold
  // (`copilot skill list`, 1.0.94), so Copilot gets its own substitutions beside another CLI's.
  skillDirectory: '.github/skills',
  entryPoints: {},
  replacements: {
    CLI_WORKTREE_CREATE: 'run `HARNESS_CLI=copilot bash "$(git rev-parse --show-toplevel)/scripts/new-worktree.sh" <task-ref> <slug>`, and work in the directory it prints',
    CLI_LANE_LAUNCH: 'Make each lane\'s worktree with `HARNESS_CLI=copilot bash "$(git rev-parse --show-toplevel)/scripts/new-worktree.sh" <task-ref> <slug>`, and start one session of this CLI in it for the lane (not verified against the CLI: where it cannot start one from here, work the lanes one after another).',
    CLI_WORKTREE_REMOVE: 'end the worktree session, then run `git worktree unlock <path>` and `git worktree remove <path>` from the primary checkout',
    CLI_VIA_MERGE: 'check that `git -C "{{PRIMARY_CHECKOUT}}" branch --show-current` prints `main`, then run `git -C "{{PRIMARY_CHECKOUT}}" merge --ff-only {{BRANCH}}`',
    CLI_WORKTREE_ISOLATION: '',
  },
  agent(agent, source, file) {
    const text = agent.tools === undefined ? source : source.replace(/^tools:.*$/m, 'tools: ' + copilotTools(agent.tools, file))
    return ['.github/agents/' + agent.name + '.agent.md', generatedMarkdown(text, file)]
  },
  hooks(groups) {
    const PreToolUse = []
    const warnings = []
    for (const group of groups) {
      const matcher = matchers[group.event]
      if (!matcher) {
        warnings.push('copilot: unsupported ' + group.event + ' hook.')
        continue
      }
      // Copilot shows no status message for a command hook, so statusMessage has no field here.
      for (const { script, timeout } of group.handlers) {
        PreToolUse.push({ type: 'command', matcher, command: 'node "$(git rev-parse --show-toplevel)/' + script + '"', timeoutSec: timeout })
      }
    }
    return { file: '.github/hooks/harness.json', contents: json({ version: 1, hooks: { PreToolUse } }), warnings }
  },
}

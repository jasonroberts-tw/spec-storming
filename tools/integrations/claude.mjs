/** Claude's native skill, agent, and hook formats; keeps Claude details out of shared definitions.
 * Called by renderIntegrations. Needs no CLI or network.
 */
import { generatedMarkdown, json } from './formats.mjs'

const events = {
  'before-command': { event: 'PreToolUse', matcher: 'Bash' },
  'before-edit': { event: 'PreToolUse', matcher: 'Write|Edit' },
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
    CLI_WORKTREE_CREATE: 'call `EnterWorktree` with the name `<issue id>-<slug>`',
    CLI_LANE_LAUNCH: 'Launch each lane with the Agent tool\'s `isolation: "worktree"`, which gives it a worktree of its own.',
    // Both finishes leave the worktree before they act on the primary checkout. Measured on Claude
    // Code 2.1.302 and 2.1.322 (docs/adr/0008): inside a worktree it made, the CLI refuses
    // `git -C <primary>` and `cd <primary> && git`, and `ExitWorktree` refuses action `remove` once
    // the branch holds a commit, telling the session to confirm with the user. After action `keep`
    // the session is in the primary checkout, where the merge and the removal both pass.
    CLI_WORKTREE_REMOVE: 'call `ExitWorktree` with action `keep`, then run `git worktree remove <path>` from the primary checkout, where the session then is. `ExitWorktree` refuses action `remove` once the branch holds a commit',
    CLI_VIA_MERGE: 'leave this worktree first, because Claude Code refuses a git command aimed at the primary checkout from inside it: call `ExitWorktree` with action `keep`, which keeps the worktree and `{{BRANCH}}`. Then, in the primary checkout, check that `git branch --show-current` prints `main`, and run `git merge --ff-only {{BRANCH}}`',
    CLI_WORKTREE_ISOLATION: "Claude Code's own worktree isolation refuses too (verified against the CLI, 2.1.322; 2.1.302 also refused `${PIPESTATUS[0]}` after a pipe): a loop whose text holds the letters git anywhere, in a file name, a path or \`github\`; a \`$(…)\` that runs git or sits in a git command, but for a commit message's here-document; \`sh -c\` or \`bash -c\` with text that names git; and \`git -C\`, or a \`cd\` to another checkout before git. So run each git command plain, from this worktree: a pipe, \`&&\` and \`;\` pass. In place of a loop over such names, run the command once for each, or use \`xargs\` or \`find -exec\`. A step that still cannot pass is a person's (\`AGENTS.md\` § Guards).",
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

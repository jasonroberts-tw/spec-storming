# Shared CLI definitions

**This directory is the hand-maintained source for CLI skills, agents, hooks, and entry points.** Shared `AGENTS.md` governs workflow rules; adapters govern native CLI syntax.

| Source | Role |
|---|---|
| `skills/` | Standard skill directories, including references, scripts, assets, and licenses |
| `agents/` | Shared agent Markdown with `name` and `description` frontmatter |
| `hooks.json` | Logical events and command scripts, timeouts in seconds, and status messages |
| `CLAUDE.md` | Claude's entry point into the shared `AGENTS.md` rules |
| `worktree-CONTEXT.md.tmpl` | Shared briefing, rendered for the active CLI and then the worktree |
| `integrations.json` (generated in a Target project) | Selected integrations and digests of owned output files |

The Template contains these sources instead of pre-rendered CLI directories. Deploy copies common
files, including this directory and the rendering tools, then invokes the integration renderer.
Generated integration files are committed in the Target project. Edit the source and re-render;
local edits to generated files cause a conflict, so rendering cannot silently discard them.

| Selection | Generated integration files |
|---|---|
| `claude` | `CLAUDE.md`, `.claude/skills/`, `.claude/agents/*.md`, `.claude/settings.json`, `.claude/worktree-CONTEXT.md.tmpl` |
| `codex` | `.agents/skills/`, `.codex/agents/*.toml`, `.codex/config.toml` |
| `copilot` | `.github/skills/`, `.github/agents/*.agent.md`, `.github/hooks/harness.json` |
| `opencode` | `.opencode/skills/`, `.opencode/agents/*.md`, `.opencode/plugins/harness.js`, `.opencode/plugins/harness-v2/server.js` |
| Several, such as `claude,copilot` | Each selected set of files, with shared definitions as their source |

## Source format

Skills keep their standard `SKILL.md` frontmatter and supporting directory contents; binary assets
and executable file modes are preserved. Each agent
has a filename matching its `name`, and single-line string fields for `name` and `description`.
Use plain strings, YAML single-quoted strings, or JSON double-quoted strings. Agent bodies are
instructions; model and tool settings belong in the adapter when a CLI needs them, except `tools`.
The Claude and Copilot adapters pass `tools` through to limit a read-only agent, and Codex's ignores
it. Copilot reads Claude's tool names there. The OpenCode adapter turns `tools` into `permission`
rules that deny every tool except the listed ones.

CLI substitutions are `{{CLI_WORKTREE_CREATE}}`, `{{CLI_WORKTREE_REMOVE}}`, and
`{{CLI_WORKTREE_ISOLATION}}`. Unknown CLI substitutions are errors. Briefing substitutions such
as `{{WORKTREE_PATH}}` are filled later by `scripts/render-worktree-context.mjs`.

Hook groups have an `event` and a nonempty `handlers` array. Each handler specifies `script`,
`timeout`, and `statusMessage`. The script must exist under `scripts/hooks/`.

| Logical event | Claude mapping | Codex mapping | Copilot mapping | OpenCode mapping |
|---|---|---|---|---|
| `before-command` | `PreToolUse`, `Bash` | `PreToolUse`, `Bash` | `PreToolUse`, `Bash` | Plugin check before `bash` (OpenCode 1) or `shell` (OpenCode 2) |
| `before-edit` | `PreToolUse`, `Write|Edit` | `PreToolUse`, `apply_patch` | `PreToolUse`, `Write|Edit` | Plugin check before `write`, `edit`, and `apply_patch` (OpenCode 1) or `patch` (OpenCode 2) |
| `worktree-create` | `WorktreeCreate` | Unsupported; reported when rendering | Unsupported; reported when rendering | Unsupported; reported when rendering |
| `worktree-remove` | `WorktreeRemove` | Unsupported; reported when rendering | Unsupported; reported when rendering | Unsupported; reported when rendering |

Codex's Bash hook payload is compatible with the command guards. The edit guard extracts every
path from Codex's patch payload, including deletion and move targets. Hook commands resolve from
the git root, so starting Codex in a subdirectory does not change the script location.

Copilot's hooks use its Claude-compatible format, which the PascalCase `PreToolUse` key selects.
Copilot then maps its own tools to Claude's names and sends Claude's payload fields. It keeps its own
argument names, such as `path` and `file_text`, and it calls a patch `Edit`.
`scripts/hooks/_shared.mjs` reads both sets of names, so the edit guards see every Copilot edit.
Copilot differs from Claude in three ways:

- A `PreToolUse` hook that exits with any code other than 0 or 2 denies the call, where Claude lets
  it run.
- Copilot shows no status message for a hook.
- Copilot also runs the hooks in `.claude/settings.json`, so with `claude,copilot` each guard runs
  twice in a Copilot session.

Copilot reads `AGENTS.md` itself, so it needs no entry point. It also reads `.claude/skills/` and
`.agents/skills/`. When two of those directories hold a skill with the same name, the copy in
`.github/skills/` wins, so Copilot gets its own text beside another CLI's. The adapter rewrites an
agent's `tools` line into Copilot's aliases, such as `read` and `search`, because VS Code maps
Claude's tool names only for an agent under `.claude/agents/`.

The `copilot` selection also serves Copilot in VS Code, which reads the same `.github/` files. VS
Code has two agent runtimes. Its Copilot runtime handles hooks as Copilot CLI does. Its Local runtime
differs from both Copilot CLI and Claude:

- It ignores `matcher`, so every hook runs for every tool call, reads included.
- It sends VS Code's own tool names and argument names, such as `replace_string_in_file` with
  `filePath`.
- A hook that exits with any code other than 0 or 2 shows a warning and lets the call run.

So each hook script decides which tools it judges. The edit guards judge only the edit tools that
`scripts/hooks/_shared.mjs` lists, so a `read_file` of a protected test passes. The two command
guards judge any call that carries a `command`. `guard-unprovisioned-worktree.mjs` judges every call,
so in the Local runtime it refuses reads in an unprovisioned worktree too.

OpenCode runs no hook commands. A plugin sees each tool call first, with OpenCode's own tool IDs and
argument names. So the adapter renders a plugin that holds the hook table:

1. The plugin turns a command, write, edit or patch call into the Claude payload the scripts read,
   such as `Edit` with `file_path` and `old_string`.
2. It runs each script for that event with the payload on stdin.
3. A script that exits 2 refuses the call, because the plugin throws the script's stderr as the
   reason. Any other exit lets the call run, as in Claude.

OpenCode 1 and OpenCode 2 load plugins in different shapes, so the adapter renders one per version
from the same code:

| Version | Plugin | What it exports | Tool and argument names |
|---|---|---|---|
| OpenCode 1, the `opencode-ai` npm package | `.opencode/plugins/harness.js` | `HarnessHooks`, whose `tool.execute.before` checks each call | `bash`, `write`, `edit`, `apply_patch`; `filePath` |
| OpenCode 2 | `.opencode/plugins/harness-v2/server.js` | a default `{ id, setup }`, whose `setup` registers `execute.before` | `shell`, `write`, `edit`, `patch`; `path` |

OpenCode 1 loads each `.js` file in `.opencode/plugins/`, and it requires every export of one to be
a plugin function. OpenCode 2 also loads a directory there, and only a module with a default
`{ id, setup }`. So OpenCode 2's plugin is a directory, and OpenCode 1 never sees it. OpenCode 2 does
see `harness.js`, and it lists that file as a plugin that failed to load. The failure stops only
that file.

OpenCode 2 looks for `.opencode/` in every directory above the session, so a session in a worktree
under `.opencode/worktrees/` loads the primary checkout's plugin too. OpenCode 2 stops activating
plugins when two share an ID, so the plugin's ID ends in a hash of its checkout's path. Only the
plugin in the nearest checkout above the session's directory runs the scripts, so each call is
judged once, by the worktree's own scripts.

The plugin finds the scripts in the checkout that holds it, so starting OpenCode in a subdirectory
does not change their location. It resolves a relative path against the session's directory.
OpenCode shows no status message for a plugin's check.

OpenCode reads `AGENTS.md` itself, and reads `CLAUDE.md` only when no `AGENTS.md` exists, so it
needs no entry point. It names an agent by its file, and it reads `tools` only as a map of booleans.
It would send a frontmatter key it does not know to the model provider as an option. So the adapter
writes an agent's `description`, and turns a `tools` list into `permission` rules: `"*": deny`
first, then `allow` for each listed tool, because the last matching rule wins. OpenCode also reads
`.claude/skills/` and `.agents/skills/`. When two of those directories hold a skill with the same
name, OpenCode 2 loads the `.opencode/skills/` copy last, so that copy wins. OpenCode 1's docs do
not say which copy wins. OpenCode 2 reads these agent files as OpenCode 1's.

Codex, Copilot and OpenCode worktree workflows run the provision script with `HARNESS_CLI` set to
their name. The script creates `.codex/worktrees/`, `.copilot/worktrees/` or `.opencode/worktrees/`,
with a briefing that has no
Claude-specific worktree isolation text. With several integrations selected, the script defaults to
the first in alphabetical order unless `HARNESS_CLI` selects another. Cleanup happens from the
primary checkout after the worktree session ends.

## Rendering and checking

```sh
node scripts/render-integrations.mjs --integrations claude,codex .
node scripts/render-integrations.mjs --integrations claude,codex --check .
```

`--source <directory>` reads definitions from another Template or Target project. The default
source is the checkout containing the script, independent of the working directory. The API is
`renderIntegrations({ root, integrations })` for in-memory output, or
`writeIntegrations({ root, target, integrations, check })` for writing or checking.

Every destination is checked before writing. An unchanged owned file can be updated or removed
when selection changes; conflicting local files and destination symlinks are refused. `--check`
also finds stale owned files. An I/O failure during writing can leave partial output; this is a
local renderer, not an atomic filesystem transaction.

The renderer does not install CLIs or change machine Bootstrap. Start Codex or Copilot in the Target
project and complete its project and hook trust review before relying on the configured hooks.
Copilot loads a folder's hooks only after the folder is trusted. VS Code's hooks are in preview.
OpenCode loads `.opencode/plugins/` at startup with no trust review.

## Official Codex formats

The adapter follows [skill discovery](https://learn.chatgpt.com/docs/build-skills),
[custom agent TOML](https://learn.chatgpt.com/docs/agent-configuration/subagents), and
[hook configuration and payloads](https://learn.chatgpt.com/docs/hooks). These documented formats
take precedence over older CLI assumptions. A Codex release supporting these formats is required.

## Official Copilot formats

The Copilot adapter follows [skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills),
[custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration),
[CLI hooks and payloads](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference),
and [custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support).
The hooks reference documents no argument names for Copilot's tools. The Copilot CLI names
`scripts/hooks/_shared.mjs` reads were not checked against a live payload. Skill precedence was
checked with `copilot skill list` in Copilot CLI 1.0.94.

For VS Code it follows [agent hooks](https://code.visualstudio.com/docs/copilot/customization/hooks),
[custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents), and
[agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills). Those pages
name neither the Local runtime's tools nor their arguments. The Local runtime's tool names, argument
names, hook locations, exit codes, and Claude tool-name mapping were read from VS Code 1.143's own
code and its built-in Copilot extension 0.71.0.

## Official OpenCode formats

The OpenCode adapter follows OpenCode 1's [plugins](https://opencode.ai/docs/plugins/),
[tools](https://opencode.ai/docs/tools/), [agent skills](https://opencode.ai/docs/skills/),
[agents](https://opencode.ai/docs/agents/), [permissions](https://opencode.ai/docs/permissions/),
and [rules](https://opencode.ai/docs/rules/). Those pages were read from their source in OpenCode's
repository on 2026-10-29. Nothing was checked against a live OpenCode. The pages name `filePath`
for `read` and `patchText` for `apply_patch`. Four things were not checked against OpenCode 1's
source:

- the `bash`, `write` and `edit` argument names the plugin reads besides `filePath`, such as
  `oldString` and `content`;
- the base of a relative path in a patch, which the tools page calls the project root;
- whether the plugin sees the tool calls of a subagent;
- which skill wins a name two skill directories hold.

OpenCode 2 has no plugin reference yet, so its plugin follows OpenCode 2's source: the `dev` branch
at commit `c24760c`, version 2.2.2, read on 2026-10-29. These files settle its format:

| File, under `packages/` | What it settles |
|---|---|
| `core/src/plugin/module.ts` | A plugin module's default export is `{ id, setup }` |
| `core/src/plugin/source-directory.ts` | `.opencode/plugins/` admits `.js` and `.ts` files and directories |
| `core/src/config/discovery.ts` | The search for `.opencode/` runs from the session's directory to the root |
| `core/src/plugin.ts` | Two plugins with one ID stop activation; a failed plugin stops only itself |
| `plugin/src/promise/adapter.ts` | A throw in `execute.before` fails that call, and `setup` returns nothing |
| `core/src/tool/plugin/*.ts` | The `shell`, `write`, `edit` and `patch` arguments, and their relative paths' base |

Two things were inferred rather than read. One is that OpenCode 2 resolves the directory's `server`
entry to `server.js`, as its `index` fallback requires. The other is that the plugin sees a
subagent's tool calls.

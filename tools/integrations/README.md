# CLI integration adapters

**These tools render shared harness definitions into native CLI configuration and protect local files during writing.** `.harness/README.md` governs the source format; each adapter governs its CLI's output.

| File | Role |
|---|---|
| `adapters.mjs` | Registry, selection validation, CLI substitutions, and active integration |
| `claude.mjs` | Claude skill locations, agent format, entry points, and hook mapping |
| `codex.mjs` | Codex skill locations, TOML agents, hooks, and unsupported-event reporting |
| `copilot.mjs` | GitHub Copilot skill locations, agent profiles and tool aliases, hooks, and unsupported-event reporting, for Copilot CLI and VS Code |
| `formats.mjs` | Deterministic serialization and shared Markdown metadata |
| `opencode.mjs` | OpenCode skill locations, agent permission rules, the OpenCode 1 and OpenCode 2 plugins that run the hook scripts, and unsupported-event reporting |
| `render.mjs` | Dependency-free in-memory rendering API |
| `write.mjs` | Ownership preflight, writing, stale output removal, and read-only checks |
| `selftest.mjs` | Temporary-project tests using a native TOML parser and real hook execution |

Add another CLI by defining an adapter and registering it in `adapters.mjs`. Adapters supply permitted
`outputPaths` (directory prefixes ending in `/` or exact files), a skill directory, agent renderer,
hook renderer (one `file` and its `contents`, or `files` as pairs for several), entry point map, and
CLI substitutions. Keep native event
names and format details in the adapter, and add tests for its native output and capability gaps.

# Shared agents

**These Markdown definitions provide the same agent instructions to each CLI adapter.** Shared `AGENTS.md` governs workflow rules; the adapter governs the emitted format.

| File | Role |
|---|---|
| `adversarial-verifier.md` | Attempts to falsify claims using independently derived evidence |
| `fan-out-work.md` | Dispatches ready issues to worktree lanes and integrates their output |
| `skill-assessor.md` | Reads an outside skill as data and reports its conflicts with this repository's rules; read-only tools |
| `spec-reviewer.md` | Reviews a change against its spec and track in a fresh context, and reports each gap with the phase it points back to |

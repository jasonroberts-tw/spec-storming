# `test-support/`

**The server tests' stand-in for the Agent SDK's `query()`, so a test can run an agent without starting Claude Code.**

`agents/runner.ts` exports `setQueryImpl`, which replaces the `query()` that every agent run calls.
The files here script that replacement, and `preload.ts` makes sure no test reaches the real one.
The code wins where this file and the code disagree.

| File | What it is |
|---|---|
| `sdkMessages.ts` | Builds the SDK messages a fake run emits, with only the fields `runner.ts` reads. It is the one test file that knows their shape. |
| `fakeQuery.ts` | `fakeQuery(script)`, `useFakeQuery(t, script)` and `callSdkTool(server, tool, input)`. A script replays text, streaming deltas, tool calls, hangs, throws and the result message. A tool that `options.allowedTools` leaves out is recorded as denied and does not run. |
| `fakeQuery.test.ts` | Checks the fake's tool calls against the canvas tool: an allowed call writes with one `canvas.updated`, a denied call writes nothing, and an input the schema refuses writes nothing. |
| `preload.ts` | Loaded by the `test` script with `--import`, after tsx. It blanks the `LANGFUSE_*`, `ZOOM_*` and `MURAL_CLIENT_*` variables before `tracing.ts` and `config.ts` load, and it installs a `query()` that refuses the run and fails the test file. |

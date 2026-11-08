# `test-support/`

**The server tests' stand-in for the Agent SDK's `query()`, so a test can run an agent without starting Claude Code.**

`agents/runner.ts` exports `setQueryImpl`, which replaces the `query()` that every agent run calls.
The files here script that replacement. Under the server's `test` script, `preload.ts` replaces
the runner's `query()` with one that fails the test file. So a test that forgets its fake fails
instead of starting Claude Code, as long as its agent runs through the runner.
`agents/querySeam.test.ts` refuses a second module that reaches the SDK's `query`, `startup` or
`prewarm` by a module name holding the SDK's package name. Its header lists the forms known to pass
it, such as an import alias, and says that others may pass too. The server's `test` script loads
the preload. A run by hand, such as `node --import tsx --test <file>`, or an editor's test runner
loads it only when one of its own `--import` flags reaches `preload.ts`; put it after
`--import tsx`, as the `test` script does. For example, a run from `src/packages/server/` can add
`--import ./src/test-support/preload.ts`.
The code wins where this file and the code disagree.

| File | What it is |
|---|---|
| `sdkMessages.ts` | Builds the SDK messages a fake run emits, with only the fields `runner.ts` reads. It is the one test file that knows their shape. |
| `fakeQuery.ts` | `fakeQuery(script)`, `useFakeQuery(t, script)` and `callSdkTool(server, tool, input)`. A script replays text, streaming deltas, tool calls, hangs, throws and the result message. A tool that `options.allowedTools` leaves out is recorded as denied and does not run. |
| `fakeQuery.test.ts` | First checks the premise `callSdkTool` rests on: the instance that `createSdkMcpServer` returns serves a probe tool to an MCP Client, twice. Then it checks the fake's tool calls against the canvas tool: an allowed call writes with one `canvas.updated`, a denied call writes nothing, and an input the schema refuses writes nothing. |
| `preload.ts` | Loaded by the `test` script with `--import`, after tsx. Before `tracing.ts` and `config.ts` load, it sets two sets of variables to an empty string: the names in its `BLANKED_NAMES`, and the `LANGFUSE_*`, `ZOOM_*` and `MURAL_CLIENT_*` names already in the environment. It also installs a `query()` in the runner that refuses the run and fails the test file. |
| `preload.test.ts` | Runs `forgetsFake.fixture.ts` as the suite runs a test file, and checks that the file fails and spawns no process, with a control run that installs a fake and passes. It also fails when the server reads a prefixed variable, written as `process.env.NAME`, that `BLANKED_NAMES` leaves out. A read written another way is not checked. |
| `forgetsFake.fixture.ts` | A test file that runs an agent without a fake. Only `preload.test.ts` runs it, because its name is outside the test glob. |

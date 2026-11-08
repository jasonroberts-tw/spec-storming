/**
 * A test file that runs an agent and forgets its fake. preload.test.ts runs it in a child process;
 * the test glob never matches it. Its one test asserts nothing, so only the preload can fail it.
 *
 * It writes what it saw to the JSON file that FORGETS_FAKE_REPORT names: how many processes the run
 * spawned, the run's errorDetail, and the exit code the preload set. FORGETS_FAKE_INSTALL=1 makes it
 * install a fake first, which is preload.test.ts's control case.
 */
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { runAgentDirect } from "../agents/runner.ts";
import { useFakeQuery } from "./fakeQuery.ts";

test("runs an agent", async (t) => {
  if (process.env.FORGETS_FAKE_INSTALL === "1") useFakeQuery(t, [{ text: "faked" }, { result: {} }]);

  let spawned = 0;
  const onSpawn = (message: unknown) => {
    spawned += 1;
    (message as { process?: { kill(signal: string): void } }).process?.kill("SIGKILL");
  };
  subscribe("child_process", onSpawn);
  try {
    const result = await runAgentDirect({
      agent: "coach",
      systemPrompt: "system",
      prompt: "prompt",
      // Should the preload ever fail to refuse, the real query() would look for Claude Code here,
      // find nothing, and start no process.
      options: { pathToClaudeCodeExecutable: "/nonexistent/claude-code-for-a-test" },
    });
    const report = process.env.FORGETS_FAKE_REPORT;
    if (report) {
      writeFileSync(
        report,
        JSON.stringify({ spawned, errorDetail: result.errorDetail ?? null, exitCode: process.exitCode ?? null }),
      );
    }
  } finally {
    unsubscribe("child_process", onSpawn);
  }
});

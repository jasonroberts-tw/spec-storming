/**
 * Tracing stays off in the tests that the server's `test` script runs. That script loads
 * test-support/preload.ts, which blanks the two Langfuse keys before this module loads. That holds
 * only because process.loadEnvFile leaves a variable that is already set alone. Were that false,
 * a developer's src/.env would start OpenTelemetry in every test that imports an agent.
 */
import { strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tracingEnabled } from "./tracing.ts";

test("tracing is off in tests, whatever src/.env holds", () => {
  strictEqual(tracingEnabled, false);
});

test("process.loadEnvFile leaves a variable that is already set alone, even an empty one", (t) => {
  // tracingEnabled alone passes trivially on a machine with no src/.env, so this checks the
  // premise itself, against a file of its own.
  const dir = mkdtempSync(join(tmpdir(), "ss-load-env-file-"));
  t.after(() => {
    process.env.LANGFUSE_PUBLIC_KEY = "";
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, ".env");
  writeFileSync(file, "LANGFUSE_PUBLIC_KEY=from-a-dotenv-file\n");
  strictEqual(process.env.LANGFUSE_PUBLIC_KEY, "", "the preload blanked it");

  process.loadEnvFile(file);

  strictEqual(process.env.LANGFUSE_PUBLIC_KEY, "");
});

/**
 * The preload's two guarantees. A test file that runs an agent and forgets its fake fails, and
 * starts no Claude Code process. And every LANGFUSE_*, ZOOM_* and MURAL_CLIENT_* variable the
 * server reads is blanked before the server's modules load.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BLANKED_NAMES, BLANKED_PREFIXES, NO_FAKE_MESSAGE } from "./preload.ts";

const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SRC = fileURLToPath(new URL("../", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./forgetsFake.fixture.ts", import.meta.url));

/** Run the fixture as the server's test script runs a test file, and read what it reported. */
function runFixture(t: { after(fn: () => void): void }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ss-forgets-fake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportPath = join(dir, "report.json");
  // NODE_TEST_CONTEXT tells a node --test process that a parent runner reads its output, which
  // would make this one report to the test that spawned it instead of running as the suite does.
  const { NODE_TEST_CONTEXT: _parentRunner, ...inherited } = process.env;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, "--test", FIXTURE], {
    cwd: SERVER_DIR,
    env: { ...inherited, ...env, FORGETS_FAKE_REPORT: reportPath },
    encoding: "utf-8",
    timeout: 60_000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  ok(existsSync(reportPath), `the fixture wrote no report:\n${output}`);
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
    spawned: number;
    errorDetail: string | null;
    exitCode: number | null;
  };
  return { status: run.status, output, report };
}

test("a test file that runs an agent without a fake fails, and starts no Claude Code process", (t) => {
  const { status, output, report } = runFixture(t);

  strictEqual(status, 1, output);
  deepStrictEqual(report, { spawned: 0, errorDetail: NO_FAKE_MESSAGE, exitCode: 1 });
  match(output, /\[test-support\] a test reached the Agent SDK query\(\) with no fake installed/);
});

test("control: the same file passes once it installs a fake", (t) => {
  const { status, output, report } = runFixture(t, { FORGETS_FAKE_INSTALL: "1" });

  strictEqual(status, 0, output);
  deepStrictEqual(report, { spawned: 0, errorDetail: null, exitCode: null });
});

/** Every server source file outside test-support/, tests included. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("the preload blanks every LANGFUSE_*, ZOOM_* and MURAL_CLIENT_* variable the server reads", () => {
  const read = new Set<string>();
  const files = sourceFiles(SRC);
  ok(files.some((file) => file.endsWith("tracing.ts")), "the scan reached tracing.ts");
  ok(files.some((file) => file.endsWith("config.ts")), "the scan reached config.ts");
  for (const file of files) {
    for (const [, name] of readFileSync(file, "utf-8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (BLANKED_PREFIXES.some((prefix) => name.startsWith(prefix))) read.add(name);
    }
  }
  ok(read.has("LANGFUSE_PUBLIC_KEY"), "the scan found the Langfuse keys tracing.ts reads");
  deepStrictEqual(
    [...read].filter((name) => !BLANKED_NAMES.includes(name)),
    [],
    "a variable the server reads that the preload's BLANKED_NAMES leaves out",
  );
  for (const name of BLANKED_NAMES) strictEqual(process.env[name], "", name);
});

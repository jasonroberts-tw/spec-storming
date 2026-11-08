/**
 * Reproduces ss-pys. Every path the server builds from repoRoot must name a real directory, so the
 * conversion from config.ts's file URL must decode a space and give a Windows drive path on Windows.
 */
import { ok, strictEqual } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SERVER_CONFIG, mcpRepoPathFrom, repoRootFrom } from "./config.ts";

const posix = { windows: false };
const windows = { windows: true };

test("repoRoot decodes a space in the checkout's path", () => {
  strictEqual(
    repoRootFrom("file:///Users/a%20b/repo/src/packages/server/src/config.ts", posix),
    "/Users/a b/repo/src/",
  );
});

test("repoRoot is a drive path for a Windows checkout", () => {
  strictEqual(
    repoRootFrom("file:///C:/a%20b/repo/src/packages/server/src/config.ts", windows),
    "C:\\a b\\repo\\src\\",
  );
});

test("mcpRepoPath decodes a space in the checkout's path", () => {
  strictEqual(
    mcpRepoPathFrom("file:///Users/a%20b/repo/src/packages/server/src/config.ts", posix),
    "/Users/a b/repo/src/mcp-mural",
  );
});

test("repoRoot of a checkout with a plain path is its src/ directory", () => {
  strictEqual(
    repoRootFrom("file:///Users/ab/repo/src/packages/server/src/config.ts", posix),
    "/Users/ab/repo/src/",
  );
});

test("this checkout's repoRoot holds the steering documents", () => {
  ok(existsSync(join(SERVER_CONFIG.repoRoot, "steering", "eventstorming.md")));
});

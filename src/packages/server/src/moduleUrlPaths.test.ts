/**
 * Guards the fix for ss-pys where config.test.ts cannot: at the call sites. URL.pathname keeps
 * percent-escapes such as %20 and puts a slash before a Windows drive letter, so a path built that
 * way from import.meta.url names no real directory when the checkout's path holds a space or a
 * drive letter. config.test.ts checks the helpers in config.ts, but a call site that went back to
 * URL.pathname still passes it on any checkout whose path has no space. This test reads every
 * server source file and refuses that form wherever it appears, tracing.ts's .env paths included.
 */
import { deepStrictEqual, ok } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
// A URL built from this module's own URL, read back as a path through .pathname.
const PATHNAME_FROM_MODULE_URL = /import\.meta\.url\s*\)\s*\.pathname/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("the pattern this test refuses matches the form ss-pys removed", () => {
  ok(PATHNAME_FROM_MODULE_URL.test('new URL("../../../", import.meta.url).pathname'));
  ok(!PATHNAME_FROM_MODULE_URL.test('fileURLToPath(new URL("../../../", import.meta.url))'));
});

test("no server module turns its own URL into a path through URL.pathname", () => {
  const files = sourceFiles(SRC);
  ok(files.some((file) => file.endsWith("config.ts")), "the scan reached config.ts");
  ok(files.some((file) => file.endsWith("tracing.ts")), "the scan reached tracing.ts");
  const offenders = files
    .filter((file) => PATHNAME_FROM_MODULE_URL.test(readFileSync(file, "utf-8")))
    .map((file) => relative(SRC, file));
  deepStrictEqual(offenders, []);
});

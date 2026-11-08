/**
 * Loaded by the server's `test` script with --import, after tsx, so it runs first in the process
 * of every test file. It does two things, in this order.
 *
 * 1. It sets every LANGFUSE_*, ZOOM_* and MURAL_CLIENT_* variable to an empty string, before
 *    observability/tracing.ts and config.ts load. tracing.ts loads src/.env with
 *    process.loadEnvFile, which leaves a variable that is already set alone, so a developer's
 *    Langfuse keys cannot start OpenTelemetry in a test, and their Zoom and Mural credentials
 *    cannot reach config.ts. A variable that is set and empty reads as off everywhere the server
 *    reads one.
 * 2. It installs a QueryFn in agents/runner.ts that refuses the run. A test that reaches query()
 *    without useFakeQuery gets an error result, and its file's process exits 1, so the test file
 *    fails even when the agent that called query() swallows the error, as every agent does. The
 *    real query(), which starts Claude Code, is never reached from a test.
 *
 * The refusal is an iterable that throws when the runner reads it, rather than a throw from the
 * call itself. The runner calls query() before its try block, so a throw there would skip the
 * cleanup that clears the run's timeout, and the pending timer would hold the file open for as
 * long as the timeout.
 */
import type { QueryFn } from "../agents/runner.ts";

/** Every variable with one of these prefixes is blanked. */
export const BLANKED_PREFIXES = ["LANGFUSE_", "ZOOM_", "MURAL_CLIENT_"];

/**
 * The prefixed variables the server reads, blanked even when the environment lacks them, so that
 * src/.env cannot set them. preload.test.ts fails when the server reads one this list leaves out.
 */
export const BLANKED_NAMES = [
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "MURAL_CLIENT_ID",
  "MURAL_CLIENT_SECRET",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
  "ZOOM_RTMS_ALLOW_INSECURE_URLS",
  "ZOOM_RTMS_ENABLED",
  "ZOOM_WEBHOOK_SECRET_TOKEN",
];

export const NO_FAKE_MESSAGE =
  "a test reached the Agent SDK query() with no fake installed; call useFakeQuery(t, script) " +
  "from test-support/fakeQuery.ts before the agent runs";

const inherited = Object.keys(process.env).filter((name) =>
  BLANKED_PREFIXES.some((prefix) => name.startsWith(prefix)),
);
for (const name of new Set([...BLANKED_NAMES, ...inherited])) process.env[name] = "";

const refuseQuery: QueryFn = () => {
  process.exitCode = 1;
  console.error(`[test-support] ${NO_FAKE_MESSAGE}`);
  return (async function* () {
    throw new Error(NO_FAKE_MESSAGE);
  })();
};

// Imported only now, because a static import is evaluated before this module's own code, and
// runner.ts loads tracing.ts and config.ts, which read the variables blanked above.
const { setQueryImpl } = await import("../agents/runner.ts");
setQueryImpl(refuseQuery);

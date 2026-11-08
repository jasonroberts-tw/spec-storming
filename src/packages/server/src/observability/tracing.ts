/**
 * Langfuse v5 (OpenTelemetry) observability bootstrap.
 *
 * The Claude Agent SDK runs each query() as a CLI subprocess, so the in-process
 * Anthropic SDK is never called here — ordinary in-process auto-instrumentation
 * can't see those LLM calls. We therefore trace manually: every agent run (in
 * agents/runner.ts) is recorded as a Langfuse `generation`, and the call-site
 * roots (synthesizer pass, coach question, spec pipeline) open a parent span via
 * withSpan() so the generations beneath them nest into a single trace grouped by
 * sessionId.
 *
 * Entirely env-gated: with no LANGFUSE_PUBLIC_KEY/SECRET_KEY the module is a
 * no-op and the app runs exactly as before. Importing this module first (see
 * index.ts) starts the OpenTelemetry SDK before anything emits a span.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation, type LangfuseSpan } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { fileURLToPath } from "node:url";

// tsx does not auto-load .env, so do it ourselves (best-effort). Try the repo
// root then the server package; ignore a missing file or a runtime without the API.
// fileURLToPath, not URL.pathname, which keeps %20 and the slash before a Windows
// drive letter, so the load would fail silently. This module does not import
// config.ts, because config.ts reads process.env when it loads, before .env would.
function tryLoadEnv(path: string): void {
  try {
    (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(path);
  } catch {
    /* no .env at this path — fine, keys may come from the real environment */
  }
}
tryLoadEnv(fileURLToPath(new URL("../../../../.env", import.meta.url))); // repo root
tryLoadEnv(fileURLToPath(new URL("../../.env", import.meta.url))); // packages/server

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

/** True when Langfuse credentials are present; all tracing helpers no-op otherwise. */
export const tracingEnabled = Boolean(publicKey && secretKey);

let spanProcessor: LangfuseSpanProcessor | null = null;

if (tracingEnabled) {
  spanProcessor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV ?? "development",
  });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  console.error(`[langfuse] tracing enabled → ${baseUrl}`);
} else {
  console.error("[langfuse] LANGFUSE_PUBLIC_KEY/SECRET_KEY not set — tracing disabled");
}

export interface SpanContextOpts {
  /** Groups all traces from the same EventStorming session in the Langfuse UI. */
  sessionId?: string;
  /** Trace-level dimensions (string values only, ≤200 chars — Langfuse drops the rest). */
  metadata?: Record<string, string>;
  /** Input payload to record on the parent span. */
  input?: unknown;
}

/**
 * Run `fn` inside a Langfuse parent span so the generation(s) it spawns nest into one
 * trace, tagged with sessionId. No-op (just runs `fn`) when tracing is disabled.
 */
export async function withSpan<T>(
  name: string,
  opts: SpanContextOpts,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled) return fn();
  const run = (): Promise<T> =>
    startActiveObservation(name, async (span: LangfuseSpan) => {
      if (opts.input !== undefined) span.update({ input: opts.input });
      return fn();
    }) as Promise<T>;
  if (opts.sessionId || opts.metadata) {
    return propagateAttributes({ sessionId: opts.sessionId, metadata: opts.metadata }, run);
  }
  return run();
}

/** Force-flush buffered spans to Langfuse (demo immediacy + clean shutdown). */
export async function flushTracing(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (err) {
    console.error("[langfuse] flush failed:", err instanceof Error ? err.message : err);
  }
}

/** Flush and tear down the exporter on process exit. */
export async function shutdownTracing(): Promise<void> {
  if (!spanProcessor) return;
  await flushTracing();
  try {
    await spanProcessor.shutdown();
  } catch {
    /* best-effort */
  }
}

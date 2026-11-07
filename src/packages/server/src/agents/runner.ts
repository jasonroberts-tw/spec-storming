import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { startObservation } from "@langfuse/tracing";
import { SERVER_CONFIG } from "../config.ts";
import { tracingEnabled } from "../observability/tracing.ts";
import { agentScheduler, type AgentIdentity } from "./scheduler.ts";

export { agentScheduler } from "./scheduler.ts";
export type { AgentIdentity, AgentLifecycleEvent } from "./scheduler.ts";

/** Read and concatenate steering docs into a single system-prompt section. */
export async function loadSteering(names: string[]): Promise<string> {
  const parts = await Promise.all(
    names.map(async (name) => {
      const file = join(SERVER_CONFIG.repoRoot, "steering", `${name}.md`);
      return readFile(file, "utf-8");
    }),
  );
  return parts.join("\n\n---\n\n");
}

export interface RunAgentParams {
  /** Which agent this run belongs to — determines scheduling priority and agent.status identity. */
  agent: AgentIdentity;
  systemPrompt: string;
  prompt: string;
  options?: Partial<Options>;
  /** Called with each chunk of assistant text as it arrives (streaming). */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  /** Hard wall-clock limit for the run (starts when execution begins, not while queued). */
  timeoutMs?: number;
  /** Replace a still-queued run with the same key instead of queueing another (see scheduler). */
  replaceKey?: string;
  /** Langfuse generation name for this run (e.g. "synthesizer", "negotiation:draft"). */
  label?: string;
  /** Extra string-valued metadata recorded on the Langfuse generation. */
  traceMetadata?: Record<string, string>;
}

export interface RunAgentResult {
  text: string;
  costUsd?: number;
  isError: boolean;
  /** Short human-readable failure cause when isError (timeout/cancel/error). */
  errorDetail?: string;
}

/**
 * Run a single-prompt agent query, serialized through the process-wide AgentScheduler
 * (concurrent SDK queries can return empty). Coach runs jump the queue; hints wait for
 * everything else. Returns the final assistant text and cost; a queued run replaced via
 * replaceKey resolves to an empty non-error result.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const result = await agentScheduler.schedule(params.agent, () => executeAgentQuery(params), {
    replaceKey: params.replaceKey,
    outcome: (value) => {
      const r = value as RunAgentResult;
      return { failed: r.isError, detail: r.errorDetail };
    },
  });
  return result ?? { text: "", isError: false };
}

/** The actual SDK query, run by the scheduler with the single-flight guarantee. */
async function executeAgentQuery(params: RunAgentParams): Promise<RunAgentResult> {
  const { systemPrompt, prompt, options, onText, signal, timeoutMs } = params;

  // A job can sit in the scheduler queue for minutes, and the caller may be cancelled while it
  // waits. Check before spawning: addEventListener never fires on an ALREADY-aborted signal, so
  // without this an abandoned run's queued steps still each launch a full SDK query.
  if (signal?.aborted) return { text: "", isError: true, errorDetail: "cancelled" };

  const abort = new AbortController();
  if (signal) signal.addEventListener("abort", () => abort.abort(), { once: true });
  // The timeout starts here — at execution, not while queued behind other runs.
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs)
    : null;

  let text = "";
  let costUsd: number | undefined;
  let isError = false;
  let errorDetail: string | undefined;

  // Record this run as a Langfuse generation. It auto-nests under whatever parent
  // span the caller opened via withSpan() (synthesizer pass / coach / pipeline).
  const generation = tracingEnabled
    ? startObservation(
        params.label ?? "agent.run",
        {
          model: options?.model,
          input: { system: systemPrompt, prompt },
          metadata: params.traceMetadata,
        },
        { asType: "generation" },
      )
    : null;

  const response = query({
    prompt,
    options: {
      systemPrompt,
      cwd: SERVER_CONFIG.repoRoot,
      // No filesystem settings. Omitted, the SDK loads every source like the CLI does, which puts
      // the developer's CLAUDE.md files, skills and hooks into product prompts. Agent knowledge
      // comes from steering/ through loadSteering() instead.
      settingSources: [],
      // No built-in tools, and a hard deny for any tool outside the caller's allowedTools.
      // Transcript text reaches every prompt, so a line spoken in a Zoom meeting must not be able
      // to steer an agent into Bash, or into Read on src/.env. An agent can call only the MCP
      // tools it passes in mcpServers and lists in allowedTools.
      tools: [],
      permissionMode: "dontAsk",
      abortController: abort,
      includePartialMessages: Boolean(onText),
      ...options,
    },
  });

  try {
    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (message.type === "stream_event" && onText) {
        // Partial streaming deltas (includePartialMessages). Forward text deltas.
        const ev = (
          message as { event?: { type?: string; delta?: { type?: string; text?: string } } }
        ).event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          onText(ev.delta.text);
        }
      } else if (message.type === "result") {
        costUsd = (message as { total_cost_usd?: number }).total_cost_usd;
        isError = (message as { is_error?: boolean }).is_error ?? false;
        if (isError) errorDetail = "agent reported an error";
      }
    }
  } catch (err) {
    // Aborts (timeout/cancel) and SDK result errors (e.g. max-turns/budget) surface here.
    // Treat them as soft errors and return whatever text we accumulated, so a single
    // failed step never crashes the caller (synthesis loop / spec pipeline).
    isError = true;
    if (timedOut) {
      errorDetail = `timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`;
    } else if (abort.signal.aborted) {
      errorDetail = "cancelled";
    } else {
      errorDetail = err instanceof Error ? err.message : String(err);
      console.error("[runner] query error:", errorDetail);
    }
  } finally {
    if (generation) {
      try {
        generation.update({
          output: text,
          level: isError ? "ERROR" : "DEFAULT",
          ...(costUsd !== undefined ? { costDetails: { total: costUsd } } : {}),
        });
        generation.end();
      } catch {
        /* never let tracing break a run */
      }
    }
    if (timer) clearTimeout(timer);
  }

  return { text, costUsd, isError, errorDetail };
}

/**
 * Run an agent query directly, bypassing the process-wide scheduler. Use when the caller
 * manages concurrency itself (e.g. parallel synthesis windows). Canvas tool calls are
 * synchronous in the event loop, so concurrent calls are safe without extra locking.
 */
export async function runAgentDirect(params: RunAgentParams): Promise<RunAgentResult> {
  return executeAgentQuery(params);
}

/**
 * Assert that a spec-pipeline step actually produced a specification. runAgentText returns its
 * best attempt even when every attempt failed, and the SDK surfaces transport/API failures as
 * ordinary assistant text ("API Error: Request rejected (429)…"). Without this guard that string
 * is written into the artifact and broadcast as a finished spec, and the pipeline still reports
 * `done` — so a hard failure looks like a successful run with a strange document.
 */
export function requireAgentText(result: RunAgentResult, step: string): string {
  const text = result.text.trim();
  if (result.isError || !text || /^API Error[:\s]/i.test(text)) {
    const cause = result.errorDetail ?? (text ? text.slice(0, 300) : "empty response");
    throw new Error(`${step} produced no usable output: ${cause}`);
  }
  return text;
}

/**
 * Run an agent expecting a substantial text result, retrying if it comes back empty/short or
 * errored. Large single-turn generations occasionally return empty from the SDK; a retry
 * almost always succeeds. Returns the best (longest) attempt.
 */
export async function runAgentText(
  params: RunAgentParams,
  opts: { minLength?: number; attempts?: number } = {},
): Promise<RunAgentResult> {
  const minLength = opts.minLength ?? 400;
  const attempts = opts.attempts ?? 3;
  let best: RunAgentResult = { text: "", isError: true };
  for (let i = 0; i < attempts; i++) {
    const result = await runAgent(params);
    if (result.text.trim().length > best.text.trim().length) best = result;
    if (!result.isError && result.text.trim().length >= minLength) return result;
    // A cancelled run always looks "short/errored"; retrying it just queues more work for a
    // caller that has already been abandoned.
    if (params.signal?.aborted) return best;
    if (i < attempts - 1) {
      console.error(
        `[runner] short/empty result (len=${result.text.trim().length}), retrying (${i + 2}/${attempts})…`,
      );
    }
  }
  return best;
}

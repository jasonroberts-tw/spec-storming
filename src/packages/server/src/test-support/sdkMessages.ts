/**
 * Agent SDK messages for tests, built with only the fields that agents/runner.ts reads. This is the
 * one test file that knows their shape, so a change to what the runner reads changes this file and
 * no test.
 *
 * Each builder casts to SDKMessage, because a real message carries ids, usage and a session that
 * the runner never reads. A field the runner starts to read must be added here first, or a test
 * built on these messages passes over a field the real SDK fills.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** An assistant message holding one text block. The runner joins the text of every one. */
export function assistantText(text: string): SDKMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } } as unknown as SDKMessage;
}

/** A partial streaming event carrying one text delta. The runner forwards it to onText. */
export function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

/** The result message that ends a run. The runner reads its cost and its error flag. */
export function resultMessage(opts: { costUsd?: number; isError?: boolean } = {}): SDKMessage {
  return {
    type: "result",
    ...(opts.costUsd !== undefined ? { total_cost_usd: opts.costUsd } : {}),
    is_error: opts.isError ?? false,
  } as unknown as SDKMessage;
}

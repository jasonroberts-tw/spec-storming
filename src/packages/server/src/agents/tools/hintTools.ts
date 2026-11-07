import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HINT_KINDS, type HintKind } from "@specstorming/shared";
import { HINTS_CONFIG } from "../../config.ts";
import type { SessionMemory } from "../../memory/SessionMemory.ts";

const hintInput = z.object({
  id: z.string().describe("stable kebab-case id, e.g. 'discuss-refund-hotspot'"),
  kind: z
    .enum(HINT_KINDS as [string, ...string[]])
    .describe("discuss-hotspot | clarify-ambiguity | go-broader | go-deeper | next-topic"),
  text: z.string().describe("short imperative guidance shown on the canvas, one sentence"),
  prompt: z
    .string()
    .describe(
      "pre-authored seed for the coach conversation when engaged — include the concrete target text and why it matters, so the coach can respond without re-deriving context",
    ),
  targetId: z
    .string()
    .optional()
    .describe("id of the sticky / hotspot / bounded context this hint concerns"),
  sourceChunkIds: z.array(z.string()).optional().describe("transcript chunk ids e.g. ['t-0003']"),
});

/**
 * In-process MCP server giving the HintAgent write access to the hint store (and nothing
 * else — hints never touch the canvas). One batch call per pass; the memory layer enforces
 * the active-hint cap and refuses to resurrect engaged/dismissed ids.
 */
export function createHintTools(memory: SessionMemory) {
  const suggestHints = tool(
    "suggest_hints",
    "Suggest coach hints for the facilitator. Pass ALL hints for this pass in ONE call. Pass an empty array (or omit) when nothing is genuinely worth interrupting for — that is the normal case. Reuse an existing active hint's id to refine its wording.",
    {
      hints: z.array(hintInput).optional(),
    },
    async (args) => {
      let applied = 0;
      for (const h of args.hints ?? []) {
        const stored = memory.upsertHint(
          {
            id: h.id,
            kind: h.kind as HintKind,
            text: h.text,
            prompt: h.prompt,
            targetId: h.targetId,
            sourceChunkIds: h.sourceChunkIds,
          },
          HINTS_CONFIG.maxActive,
        );
        if (stored) applied += 1;
      }
      return { content: [{ type: "text" as const, text: `applied ${applied} hint(s)` }] };
    },
  );

  return createSdkMcpServer({ name: "hints", version: "0.1.0", tools: [suggestHints] });
}

/** Tool names as the model sees them, for options.allowedTools. */
export const HINT_TOOL_NAMES = ["mcp__hints__suggest_hints"];

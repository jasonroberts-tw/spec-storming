import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { STICKY_KINDS } from "@specstorming/shared";
import type { SessionMemory } from "../../memory/SessionMemory.ts";

const confidence = z.enum(["low", "medium", "high"]);

const stickyInput = z.object({
  id: z.string().describe("stable kebab-case id, e.g. 'order-placed'"),
  kind: z
    .enum(STICKY_KINDS as [string, ...string[]])
    .describe("domainEvent | command | actor | policy | readModel | externalSystem | hotspot | aggregate"),
  text: z.string().describe("sticky label; domain events in past tense"),
  confidence: confidence.optional(),
  sourceChunkIds: z.array(z.string()).optional().describe("transcript chunk ids e.g. ['t-0003']"),
  boundedContextId: z.string().optional(),
  order: z.number().optional().describe("left-to-right timeline ordering hint"),
  links: z
    .array(
      z.object({
        toId: z.string().describe("id of the sticky this one points at"),
        relation: z.enum(["triggers", "raises", "invokes", "reads"]),
      }),
    )
    .optional()
    .describe(
      "flow edges out of this sticky: command triggers an event, policy invokes a command, " +
        "actor raises a command, read model is what a policy reads. Replaces the previous list.",
    ),
});

const bccInput = z.object({
  id: z.string().describe("stable kebab-case id, e.g. 'ordering'"),
  name: z.string(),
  purpose: z.string().describe("one-line strategic intent"),
  domain: z.enum(["core", "supporting", "generic"]),
  businessModel: z.string().optional(),
  ubiquitousLanguage: z.array(z.object({ term: z.string(), definition: z.string() })).optional(),
  inboundCommunication: z
    .array(z.object({ name: z.string(), party: z.string(), via: z.string().optional() }))
    .optional()
    .describe("messages received from other contexts; party = source context"),
  outboundCommunication: z
    .array(z.object({ name: z.string(), party: z.string(), via: z.string().optional() }))
    .optional()
    .describe("messages sent to other contexts; party = target context"),
  businessDecisions: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  stickyIds: z.array(z.string()).optional(),
  confidence: confidence.optional(),
});

const hotspotInput = z.object({
  id: z.string().describe("stable kebab-case id"),
  text: z.string(),
  sourceChunkIds: z.array(z.string()).optional(),
});

/**
 * In-process MCP server giving the Synthesizer write access to the Canvas. A single batch
 * tool (mcp__canvas__update_canvas) applies many stickies / bounded contexts / hotspots in
 * one call — far faster than one round-trip per sticky. The whole batch commits as one
 * revision with one canvas.updated broadcast.
 */
export function createCanvasTools(memory: SessionMemory) {
  const updateCanvas = tool(
    "update_canvas",
    "Apply a batch of Canvas updates in one call. Pass arrays of the stickies, bounded contexts, and hotspots to create or update. Reuse an existing id to refine an item; invent a short stable kebab-case id for new ones. Prefer ONE call with everything over many calls.",
    {
      stickies: z.array(stickyInput).optional(),
      boundedContexts: z.array(bccInput).optional(),
      hotspots: z.array(hotspotInput).optional(),
    },
    async (args) => {
      const n = memory.applyCanvasBatch({
        stickies: (args.stickies ?? []).map((s) => ({
          id: s.id,
          kind: s.kind as (typeof STICKY_KINDS)[number],
          text: s.text,
          confidence: s.confidence,
          sourceChunkIds: s.sourceChunkIds,
          boundedContextId: s.boundedContextId,
          order: s.order,
          links: s.links,
        })),
        boundedContexts: (args.boundedContexts ?? []).map((b) => ({
          id: b.id,
          name: b.name,
          purpose: b.purpose,
          strategicClassification: { domain: b.domain, businessModel: b.businessModel },
          ubiquitousLanguage: b.ubiquitousLanguage ?? [],
          inboundCommunication: b.inboundCommunication ?? [],
          outboundCommunication: b.outboundCommunication ?? [],
          businessDecisions: b.businessDecisions ?? [],
          assumptions: b.assumptions ?? [],
          openQuestions: b.openQuestions ?? [],
          stickyIds: b.stickyIds ?? [],
          confidence: b.confidence ?? "medium",
        })),
        hotspots: (args.hotspots ?? []).map((h) => ({
          id: h.id,
          text: h.text,
          sourceChunkIds: h.sourceChunkIds ?? [],
        })),
      });
      return { content: [{ type: "text" as const, text: `applied ${n} canvas update(s)` }] };
    },
  );

  return createSdkMcpServer({ name: "canvas", version: "0.1.0", tools: [updateCanvas] });
}

/** Tool names as the model sees them, for options.allowedTools. */
export const CANVAS_TOOL_NAMES = ["mcp__canvas__update_canvas"];

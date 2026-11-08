/**
 * The fake query()'s tool calls. A tool call runs through the in-process MCP server the agent
 * passes, so these tests check the fake against what a real run would do with the canvas tool:
 * an allowed call writes, a denied call does not, and an input the tool's schema refuses does not.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "@specstorming/shared";
import { z } from "zod";
import { runAgentDirect } from "../agents/runner.ts";
import { CANVAS_TOOL_NAMES, createCanvasTools } from "../agents/tools/canvasTools.ts";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import { callSdkTool, useFakeQuery, type ScriptStep } from "./fakeQuery.ts";

const UPDATE_CANVAS = "mcp__canvas__update_canvas";

const TWO_STICKIES = {
  stickies: [
    { id: "order-placed", kind: "domainEvent", text: "Order placed" },
    { id: "place-order", kind: "command", text: "Place order" },
  ],
};

/** A session and the canvas.updated events it emits. */
function session() {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  const canvasEvents: ServerEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === "canvas.updated") canvasEvents.push(event);
  });
  return { memory, canvasEvents };
}

/** A script whose model makes one update_canvas call and then finishes. */
function callsUpdateCanvas(input: Record<string, unknown>): ScriptStep[] {
  return [{ tool: UPDATE_CANVAS, input }, { text: "done" }, { result: {} }];
}

/** A run that passes the canvas tool the way the Synthesizer does, with `allowedTools`. */
function runWithCanvasTool(memory: SessionMemory, allowedTools: string[]) {
  return runAgentDirect({
    agent: "synthesizer",
    systemPrompt: "system",
    prompt: "prompt",
    options: { mcpServers: { canvas: createCanvasTools(memory) }, allowedTools },
  });
}

test("createSdkMcpServer returns an object whose instance serves MCP as an McpServer does", async () => {
  // callSdkTool in fakeQuery.ts connects that instance to an MCP Client. If this fails, the SDK
  // has changed what it returns, and callSdkTool is the one function to change.
  const double = tool("double", "Doubles n.", { n: z.number() }, async ({ n }) => ({
    content: [{ type: "text" as const, text: String(n * 2) }],
  }));
  const server = createSdkMcpServer({ name: "probe", version: "0.0.0", tools: [double] });
  strictEqual(server.type, "sdk");
  // The check is what the instance does, and not instanceof McpServer, because the Agent SDK
  // (0.3.319) bundles its own copy of the MCP SDK's McpServer. Its instance is an McpServer by its
  // type and its methods, and instanceof the McpServer this package installs is false.
  // Twice, because callSdkTool closes the instance after each call so that the next can connect.
  for (const n of [2, 5]) {
    deepStrictEqual(await callSdkTool(server, "double", { n }), {
      content: [{ type: "text", text: String(n * 2) }],
    });
  }
});

test("an update_canvas call lands its stickies with one canvas.updated", async (t) => {
  const { memory, canvasEvents } = session();
  const fake = useFakeQuery(t, callsUpdateCanvas(TWO_STICKIES));

  const result = await runWithCanvasTool(memory, CANVAS_TOOL_NAMES);

  strictEqual(result.isError, false, result.errorDetail);
  strictEqual(fake.calls.length, 1);
  const [toolCall] = fake.calls[0].toolCalls;
  strictEqual(toolCall.outcome, "ran");
  strictEqual(toolCall.result?.isError, undefined, JSON.stringify(toolCall.result));
  deepStrictEqual(
    memory.getState().canvas.stickies.map((s) => s.id),
    ["order-placed", "place-order"],
  );
  strictEqual(canvasEvents.length, 1, "two stickies, one broadcast");
});

test("a denied tool writes nothing", async (t) => {
  const { memory, canvasEvents } = session();
  const fake = useFakeQuery(t, callsUpdateCanvas(TWO_STICKIES));

  const result = await runWithCanvasTool(memory, []);

  strictEqual(result.isError, false, result.errorDetail);
  deepStrictEqual(
    fake.calls[0].toolCalls.map((c) => [c.name, c.outcome]),
    [[UPDATE_CANVAS, "denied"]],
  );
  strictEqual(memory.getState().canvas.stickies.length, 0);
  strictEqual(canvasEvents.length, 0);
});

test("an invalid input is refused", async (t) => {
  const { memory, canvasEvents } = session();
  const invalid = { stickies: [{ id: "order-placed", kind: "not-a-kind", text: "Order placed" }] };
  const fake = useFakeQuery(t, callsUpdateCanvas(invalid));

  const result = await runWithCanvasTool(memory, CANVAS_TOOL_NAMES);

  strictEqual(result.isError, false, result.errorDetail);
  const [toolCall] = fake.calls[0].toolCalls;
  strictEqual(toolCall.outcome, "ran");
  strictEqual(toolCall.result?.isError, true, "the schema refuses the call");
  const [first] = toolCall.result?.content ?? [];
  ok(first?.type === "text" && /Input validation error/.test(first.text), JSON.stringify(toolCall.result));
  strictEqual(memory.getState().canvas.stickies.length, 0);
  strictEqual(canvasEvents.length, 0);
});

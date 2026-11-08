/**
 * A scripted stand-in for the Agent SDK's query(), installed through setQueryImpl in
 * agents/runner.ts, so a test drives a real agent run without starting Claude Code.
 *
 * A script is a list of steps that the fake replays in order, one list per query() call:
 *
 *   { text }          an assistant message holding that text
 *   { delta }         a streaming text delta, which reaches onText
 *   { tool, input }   the model calling an MCP tool by its full name, mcp__<server>__<tool>
 *   { hang: true }    a call that waits until the run's abortController aborts, then throws
 *   { throws }        the SDK throwing mid-run with that message
 *   { result }        the result message that ends a run, with its cost and error flag
 *
 * A tool call runs only when options.allowedTools names it, because the runner passes
 * permissionMode "dontAsk", which denies every other tool. A denied call is recorded and writes
 * nothing. An allowed call goes through callSdkTool, so the tool's zod input schema is enforced as
 * it would be in a real run.
 *
 * The fake emits only what a script names. A script with no result step ends with no result
 * message, which the runner reads as no cost and no error.
 */
import type { TestContext } from "node:test";
import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setQueryImpl, type QueryFn } from "../agents/runner.ts";
import { assistantText, resultMessage, textDelta } from "./sdkMessages.ts";

export type ScriptStep =
  | { text: string }
  | { delta: string }
  | { tool: string; input: Record<string, unknown> }
  | { hang: true }
  | { throws: string }
  | { result: { costUsd?: number; isError?: boolean } };

/** One list of steps for every call, or a function that picks the steps for each call. */
export type Script = ScriptStep[] | ((call: FakeCall) => ScriptStep[]);

export interface ToolCall {
  /** The full tool name the script used, mcp__<server>__<tool>. */
  name: string;
  input: Record<string, unknown>;
  /** "denied" when options.allowedTools leaves the tool out, so it did not run. */
  outcome: "denied" | "ran";
  /** What the tool returned, when it ran. An input its schema refuses comes back with isError. */
  result?: CallToolResult;
}

/** One query() call, as the runner made it. */
export interface FakeCall {
  /** 0 for the first call this fake received. */
  index: number;
  prompt: string;
  options: Options;
  toolCalls: ToolCall[];
}

export interface FakeQuery {
  query: QueryFn;
  /** Every call in the order the fake received it. */
  calls: FakeCall[];
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/** A QueryFn that replays `script`, and the record of the calls it receives. */
export function fakeQuery(script: Script): FakeQuery {
  const calls: FakeCall[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const call: FakeCall = { index: calls.length, prompt, options, toolCalls: [] };
    calls.push(call);
    const steps = typeof script === "function" ? script(call) : script;
    return replay(steps, call);
  };
  return { query, calls };
}

/** Install fakeQuery(script) as the runner's query() for the length of test `t`. */
export function useFakeQuery(t: Pick<TestContext, "after">, script: Script): FakeQuery {
  const fake = fakeQuery(script);
  const restore = setQueryImpl(fake.query);
  t.after(() => restore());
  return fake;
}

/**
 * Call `tool`, by its bare name, on the in-process MCP server that createSdkMcpServer returned.
 * It goes through an MCP Client over InMemoryTransport, as a real run does, so the tool's zod input
 * schema is enforced. The server is closed again afterwards, because an McpServer accepts one
 * transport at a time.
 */
export async function callSdkTool(
  server: McpSdkServerConfigWithInstance,
  tool: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fake-query", version: "0.0.0" });
  await server.instance.connect(serverSide);
  try {
    await client.connect(clientSide);
    return (await client.callTool({ name: tool, arguments: input })) as CallToolResult;
  } finally {
    await client.close();
    await server.instance.close();
  }
}

async function* replay(steps: ScriptStep[], call: FakeCall): AsyncGenerator<SDKMessage, void> {
  const signal = call.options.abortController?.signal;
  for (const step of steps) {
    if (signal?.aborted) throw abortError();
    if ("text" in step) yield assistantText(step.text);
    else if ("delta" in step) yield textDelta(step.delta);
    else if ("result" in step) yield resultMessage(step.result);
    else if ("throws" in step) throw new Error(step.throws);
    else if ("hang" in step) {
      await untilAborted(signal);
      throw abortError();
    } else await runTool(step, call);
  }
}

async function runTool(step: { tool: string; input: Record<string, unknown> }, call: FakeCall): Promise<void> {
  const { options } = call;
  if (!(options.allowedTools ?? []).includes(step.tool)) {
    call.toolCalls.push({ name: step.tool, input: step.input, outcome: "denied" });
    return;
  }
  const match = MCP_TOOL_NAME.exec(step.tool);
  const server = match ? options.mcpServers?.[match[1]] : undefined;
  if (!match || !server || server.type !== "sdk" || !("instance" in server)) {
    throw new Error(
      `fakeQuery: allowedTools names ${step.tool}, and options.mcpServers holds no in-process server for it`,
    );
  }
  const result = await callSdkTool(server, match[2], step.input);
  call.toolCalls.push({ name: step.tool, input: step.input, outcome: "ran", result });
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("fakeQuery: a hang step needs options.abortController, or it never ends");
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** What the SDK throws when its abortController aborts a run. */
function abortError(): Error {
  const err = new Error("fakeQuery: the run's abortController aborted it");
  err.name = "AbortError";
  return err;
}

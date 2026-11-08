/**
 * The agent runner over a fake query() (test-support/fakeQuery.ts): what it reads from the SDK's
 * messages, the guardrails it passes, how each kind of failure surfaces, and the retry and
 * refusal rules the spec pipeline relies on.
 *
 * Every test here that runs an agent installs a fake first. A test that forgot would reach the
 * preload's refusal, but only when the server's `test` script loads the preload; a run without it
 * would reach the real query(). querySeam.test.ts checks that the runner is the only module that
 * reaches the SDK functions that start Claude Code by a module name holding the SDK's package
 * name. Its header lists the forms known to pass it, such as an import alias, and says that
 * others may pass too.
 */
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
import { test } from "node:test";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import { runBoundaryAnalyzer } from "../pipeline/BoundaryAnalyzer.ts";
import { runNegotiation } from "../pipeline/negotiation.ts";
import { runSolutionArchitect } from "../pipeline/SolutionArchitect.ts";
import { useFakeQuery, type ScriptStep } from "../test-support/fakeQuery.ts";
import { CoachAgent } from "./CoachAgent.ts";
import { HintAgent } from "./HintAgent.ts";
import {
  agentScheduler,
  requireAgentText,
  runAgent,
  runAgentDirect,
  runAgentText,
  type AgentLifecycleEvent,
  type RunAgentParams,
} from "./runner.ts";
import { SynthesizerAgent } from "./SynthesizerAgent.ts";

const BASE: RunAgentParams = { agent: "coach", systemPrompt: "system", prompt: "prompt" };

/** Long enough that runAgentText takes it on the first attempt (its default minLength is 400). */
const LONG_TEXT = "a specification line\n".repeat(30);

/** The private run entry points the agents' timers and listeners call. */
type RunOnce = { runOnce(): Promise<void> };
type AssessCurrentCanvas = { assessCurrentCanvas(): Promise<void> };

/** A live session that every agent's preconditions accept: four lines and one sticky. */
function liveSession(): { bus: EventBus; memory: SessionMemory } {
  const bus = new EventBus();
  const memory = new SessionMemory(bus);
  for (let i = 1; i <= 4; i++) memory.appendChunk({ speaker: "PO-Sam", text: `line ${i}` });
  memory.applyCanvasBatch({ stickies: [{ id: "order-placed", kind: "domainEvent", text: "Order placed" }] });
  return { bus, memory };
}

test("text from several assistant messages is joined, and costUsd comes from the result message", async (t) => {
  useFakeQuery(t, [{ text: "Hello, " }, { text: "world" }, { result: { costUsd: 0.25 } }]);

  deepStrictEqual(await runAgentDirect(BASE), {
    text: "Hello, world",
    costUsd: 0.25,
    isError: false,
    errorDetail: undefined,
  });
});

/**
 * Every place in the product that runs an agent, each driven through the entry point its own
 * timer, listener or route calls, with the number of query() calls one pass makes.
 */
const REAL_CALLERS: { caller: string; calls: number; run: () => Promise<unknown> }[] = [
  {
    caller: "the Synthesizer's window and grouping pass",
    calls: 2,
    run: () => {
      const { bus, memory } = liveSession();
      return (new SynthesizerAgent(memory, bus) as unknown as RunOnce).runOnce();
    },
  },
  {
    caller: "the HintAgent pass",
    calls: 1,
    run: () => {
      const { bus, memory } = liveSession();
      return (new HintAgent(memory, bus) as unknown as RunOnce).runOnce();
    },
  },
  {
    caller: "the Coach's chat reply",
    calls: 1,
    run: () => {
      const { bus, memory } = liveSession();
      return new CoachAgent(memory, bus).ask("What should we look at next?");
    },
  },
  {
    caller: "the Coach's assessment",
    calls: 1,
    run: () => {
      const { bus, memory } = liveSession();
      return (new CoachAgent(memory, bus) as unknown as AssessCurrentCanvas).assessCurrentCanvas();
    },
  },
  {
    caller: "the Boundary Analyzer and its SDD fitness evaluation",
    calls: 2,
    run: () => runBoundaryAnalyzer("artifact"),
  },
  {
    caller: "the Solution Architect and its SDD fitness evaluation",
    calls: 2,
    run: () => runSolutionArchitect("artifact"),
  },
  {
    caller: "the negotiation's draft, critique and final round",
    calls: 3,
    run: () => runNegotiation({ boundedContextSpec: "contexts", architectureSpec: "architecture" }),
  },
];

for (const { caller, calls, run } of REAL_CALLERS) {
  test(`settingSources: [], tools: [] and permissionMode: "dontAsk" reach query() from ${caller}`, async (t) => {
    const fake = useFakeQuery(t, [{ text: LONG_TEXT }, { result: {} }]);

    await run();

    strictEqual(fake.calls.length, calls, `${caller} makes ${calls} query() call(s) in one pass`);
    for (const call of fake.calls) {
      deepStrictEqual(call.options.settingSources, [], `call ${call.index}: settingSources`);
      deepStrictEqual(call.options.tools, [], `call ${call.index}: tools`);
      strictEqual(call.options.permissionMode, "dontAsk", `call ${call.index}: permissionMode`);
    }
  });
}

test("includePartialMessages is set only when onText is given, and deltas reach onText in order", async (t) => {
  const script: ScriptStep[] = [{ delta: "Hel" }, { delta: "lo" }, { delta: "!" }, { text: "Hello!" }, { result: {} }];
  const fake = useFakeQuery(t, script);
  const deltas: string[] = [];

  const silent = await runAgentDirect(BASE);
  const streamed = await runAgentDirect({ ...BASE, onText: (delta) => deltas.push(delta) });

  deepStrictEqual(
    fake.calls.map((call) => call.options.includePartialMessages),
    [false, true],
  );
  deepStrictEqual(deltas, ["Hel", "lo", "!"]);
  strictEqual(silent.text, "Hello!", "deltas never add to the text");
  strictEqual(streamed.text, "Hello!", "deltas never add to the text");
});

test("an is_error result, an aborted signal, a timeout, a mid-run abort and an SDK throw each give their own error", async (t) => {
  const scripts: Record<string, ScriptStep[]> = {
    "is_error result": [{ text: "partial" }, { result: { isError: true } }],
    "aborted signal": [{ text: "never read" }],
    timeout: [{ text: "so far" }, { hang: true }],
    "mid-run abort": [{ text: "so far" }, { hang: true }],
    "SDK throw": [{ text: "so far" }, { throws: "socket hang up" }],
  };
  const order = Object.keys(scripts);
  const fake = useFakeQuery(t, (call) => scripts[call.prompt]);

  const aborted = new AbortController();
  aborted.abort();
  const midRun = new AbortController();
  const abortSoon = () => {
    // The fake reaches its hang step within microtasks, so the abort lands mid-run.
    setTimeout(() => midRun.abort(), 20);
    return midRun.signal;
  };

  const results = {
    "is_error result": await runAgentDirect({ ...BASE, prompt: "is_error result" }),
    "aborted signal": await runAgentDirect({ ...BASE, prompt: "aborted signal", signal: aborted.signal }),
    timeout: await runAgentDirect({ ...BASE, prompt: "timeout", timeoutMs: 20 }),
    "mid-run abort": await runAgentDirect({ ...BASE, prompt: "mid-run abort", signal: abortSoon() }),
    "SDK throw": await runAgentDirect({ ...BASE, prompt: "SDK throw" }),
  };

  for (const name of order) strictEqual(results[name as keyof typeof results].isError, true, name);
  strictEqual(results["is_error result"].errorDetail, "agent reported an error");
  strictEqual(results["is_error result"].text, "partial");
  strictEqual(results["aborted signal"].errorDetail, "cancelled");
  match(results.timeout.errorDetail ?? "", /^timed out after \d+s$/);
  strictEqual(results.timeout.text, "so far", "a timed-out run keeps the text it had");
  strictEqual(results["mid-run abort"].errorDetail, "cancelled");
  strictEqual(results["mid-run abort"].text, "so far", "an aborted run keeps the text it had");
  strictEqual(results["SDK throw"].errorDetail, "socket hang up");
  strictEqual(results["SDK throw"].text, "so far", "a run the SDK throws in keeps the text it had");

  deepStrictEqual(
    fake.calls.map((call) => call.prompt),
    order.filter((name) => name !== "aborted signal"),
    "a run whose signal is already aborted never reaches query()",
  );
  const distinct = new Set([
    results["is_error result"].errorDetail,
    results.timeout.errorDetail,
    results["mid-run abort"].errorDetail,
    results["SDK throw"].errorDetail,
  ]);
  strictEqual(distinct.size, 4, "an is_error result, a timeout, an abort and a throw read differently");
});

/** Record every agent.status event the process-wide scheduler emits for the length of test `t`. */
function lifecycleEvents(t: { after(fn: () => void): void }): AgentLifecycleEvent[] {
  const events: AgentLifecycleEvent[] = [];
  const previous = agentScheduler.onLifecycle;
  agentScheduler.onLifecycle = (event) => events.push(event);
  t.after(() => {
    agentScheduler.onLifecycle = previous;
  });
  return events;
}

test("runAgent emits queued, running, done and failed through agentScheduler", async (t) => {
  const events = lifecycleEvents(t);
  useFakeQuery(t, (call) =>
    call.index === 0 ? [{ text: "fine" }, { result: {} }] : [{ result: { isError: true } }],
  );

  await runAgent({ ...BASE, agent: "coach" });
  await runAgent({ ...BASE, agent: "hints" });

  deepStrictEqual(events, [
    { agent: "coach", state: "queued" },
    { agent: "coach", state: "running" },
    { agent: "coach", state: "done" },
    { agent: "hints", state: "queued" },
    { agent: "hints", state: "running" },
    { agent: "hints", state: "failed", detail: "agent reported an error" },
  ]);
});

test("runAgentText retries and keeps the longest result", async (t) => {
  const texts = ["short", "the longest of the three", "middling"];
  const fake = useFakeQuery(t, (call) => [{ text: texts[call.index] }, { result: {} }]);

  const result = await runAgentText({ ...BASE, agent: "pipeline" });

  strictEqual(fake.calls.length, 3, "three attempts, none long enough");
  strictEqual(result.text, "the longest of the three");
});

test("runAgentText returns early once a result is long enough", async (t) => {
  const texts = ["x".repeat(10), "y".repeat(50), "z".repeat(90)];
  const fake = useFakeQuery(t, (call) => [{ text: texts[call.index] }, { result: {} }]);

  const result = await runAgentText({ ...BASE, agent: "pipeline" }, { minLength: 40 });

  strictEqual(fake.calls.length, 2, "the second attempt is long enough, so no third");
  strictEqual(result.text, "y".repeat(50));
});

test("runAgentText stops on abort", async (t) => {
  const events = lifecycleEvents(t);
  const fake = useFakeQuery(t, [{ hang: true }]);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);

  const result = await runAgentText({ ...BASE, agent: "pipeline", signal: abort.signal });

  strictEqual(fake.calls.length, 1, "a cancelled run is not retried");
  // The query() count alone cannot see a retry: a retried run whose signal is already aborted is
  // cancelled before it reaches query(), yet it still queues and runs through the scheduler.
  deepStrictEqual(
    events,
    [
      { agent: "pipeline", state: "queued" },
      { agent: "pipeline", state: "running" },
      { agent: "pipeline", state: "failed", detail: "cancelled" },
    ],
    "one scheduled run, and no retry queued behind it",
  );
  strictEqual(result.isError, true);
});

test("requireAgentText refuses empty text, and text that starts with API Error", () => {
  throws(() => requireAgentText({ text: "  \n", isError: false }, "Step"), /^Error: Step produced no usable output: empty response$/);
  throws(
    () => requireAgentText({ text: "API Error: Request rejected (429)", isError: false }, "Step"),
    /Step produced no usable output: API Error: Request rejected \(429\)/,
  );
  throws(
    () => requireAgentText({ text: "half a spec", isError: true, errorDetail: "timed out after 150s" }, "Step"),
    /Step produced no usable output: timed out after 150s/,
  );
  strictEqual(requireAgentText({ text: "  # Spec\n", isError: false }, "Step"), "# Spec");
  strictEqual(
    requireAgentText({ text: "A spec that mentions an API Error", isError: false }, "Step"),
    "A spec that mentions an API Error",
    "only text that starts with API Error is refused",
  );
});

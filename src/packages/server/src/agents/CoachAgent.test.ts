import { match, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import type { SessionState, Sticky } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { assessmentContext, assessmentDelay, provisionalAssessment } from "./CoachAgent.ts";

function sticky(
  id: string,
  kind: Sticky["kind"],
  order: number,
  boundedContextId?: string,
): Sticky {
  return {
    id,
    kind,
    text: id.replaceAll("-", " "),
    confidence: "high",
    sourceChunkIds: [`source-${id}`],
    order,
    boundedContextId,
    createdAtRev: 1,
    updatedAtRev: 1,
  };
}

/** A connected, owned, evidenced single-context model — the shape the score should reward. */
function coherentModelState(): SessionState {
  const state = emptySession("coherent", "Coherent model");
  const contextId = "ordering";
  state.canvas.stickies = [
    sticky("customer", "actor", 1, contextId),
    sticky("order-options", "readModel", 2, contextId),
    sticky("place-order", "command", 3, contextId),
    sticky("order", "aggregate", 4, contextId),
    sticky("order-placed", "domainEvent", 5, contextId),
    sticky("on-order-placed", "policy", 6, contextId),
    sticky("payment-rejected", "hotspot", 7, contextId),
  ];
  state.canvas.boundedContexts = [
    {
      id: contextId,
      name: "Ordering",
      purpose: "Accept valid customer orders and establish their lifecycle.",
      strategicClassification: { domain: "core" },
      inboundCommunication: [],
      outboundCommunication: [],
      ubiquitousLanguage: [
        { term: "Order", definition: "A customer's accepted request to purchase." },
        { term: "Placement", definition: "The decision that establishes a valid order." },
        { term: "Order Line", definition: "One requested item and quantity on an order." },
        { term: "Eligibility", definition: "Whether a customer may place an order at all." },
      ],
      businessDecisions: ["Only an eligible customer with valid order lines may place an order."],
      assumptions: [],
      openQuestions: ["How is a rejected payment recovered or terminated?"],
      stickyIds: state.canvas.stickies.map((item) => item.id),
      confidence: "high",
      createdAtRev: 1,
      updatedAtRev: 1,
    },
  ];
  state.canvas.hotspots = [
    {
      id: "payment-recovery",
      text: "Payment rejection recovery must be agreed",
      sourceChunkIds: ["source-payment-rejected"],
    },
  ];
  return state;
}

test("behavior modeled outside any bounded context is called out as the gap", () => {
  const state = coherentModelState();
  const clean = provisionalAssessment(state);
  const guidanceOf = (assessment: ReturnType<typeof provisionalAssessment>) =>
    assessment.feedback
      .filter((item) => item.tone === "constructive")
      .map((item) => `${item.summary} ${item.detail}`)
      .join(" ");

  // A coherent model earns no boundary complaint…
  ok(!/explicit bounded context/i.test(guidanceOf(clean)));

  // …until most of the behavior is drifting outside any context's ownership.
  for (let i = 0; i < 8; i += 1) {
    state.canvas.stickies.push(sticky(`unowned-event-${i}`, "domainEvent", 8 + i));
  }

  match(guidanceOf(provisionalAssessment(state)), /explicit bounded context/i);
});

test("provisional score does not mistake disconnected sticky coverage for coherence", () => {
  const state = emptySession("disconnected", "Disconnected model");
  state.canvas.stickies = [
    sticky("customer", "actor", 1),
    sticky("place-order", "command", 2),
    sticky("order", "aggregate", 3),
    sticky("order-placed", "domainEvent", 4),
    sticky("on-order-placed", "policy", 5),
    sticky("order-status", "readModel", 6),
    sticky("payment-gateway", "externalSystem", 7),
  ];
  state.canvas.hotspots = [
    { id: "cancellation", text: "Cancellation recovery is unresolved", sourceChunkIds: [] },
  ];

  const assessment = provisionalAssessment(state);

  ok(assessment.score <= 4, `disconnected model scored ${assessment.score}`);
  ok(
    assessment.maturity !== "Coherent",
    `disconnected model must not read as Coherent (got ${assessment.maturity})`,
  );
  const guidance = assessment.feedback
    .filter((item) => item.tone === "constructive")
    .map((item) => `${item.summary} ${item.detail}`)
    .join(" ");
  match(guidance, /bounded context/i);
  match(guidance, /actor.*command.*aggregate.*event/i);
});

test("provisional score recognizes a connected, owned, evidenced model", () => {
  const assessment = provisionalAssessment(coherentModelState());

  ok(assessment.score >= 8, `connected model scored ${assessment.score}`);
  strictEqual(assessment.maturity, "Coherent");
  match(assessment.scoreRationale, /connected behavior.*rules.*language.*boundaries/i);
});

/** Mirrors the sessionContext flatness test in SessionMemory.test.ts — the proactive review runs
 * on a timer, so an unbounded prompt there grows without anyone typing anything. */
test("assessment context stays flat as the transcript grows", () => {
  const short = coherentModelState();
  for (let i = 0; i < 30; i++) {
    short.transcript.push({
      id: `t-${i}`,
      ts: "2026-08-01T00:00:00Z",
      speaker: "Alice",
      text: `line ${i} about orders and payments`,
      seq: i + 1,
    });
  }
  const long = structuredClone(short);
  for (let i = 30; i < 2000; i++) {
    long.transcript.push({
      id: `t-${i}`,
      ts: "2026-08-01T00:00:00Z",
      speaker: "Bob",
      text: `line ${i} about orders and payments`,
      seq: i + 1,
    });
  }

  const shortCtx = assessmentContext(short);
  const longCtx = assessmentContext(long);
  ok(longCtx.length < shortCtx.length + 200, `grew: ${shortCtx.length} -> ${longCtx.length}`);
  ok(longCtx.includes("t-1999"), "includes the newest line");
  ok(!longCtx.includes("[t-10]"), "oldest lines are omitted");
  // The omitted-count note is load-bearing: without it the model reads the window as the whole
  // session and reports missing evidence that exists but was cut.
  match(longCtx, /1970 earlier lines omitted/);
});

/** Guards against a future "bound it like the interactive path" change that swaps in
 * sessionContext and silently strips the fields assess-domain-model scores against. */
test("assessment context keeps the canvas fields the assessment skill scores", () => {
  const ctx = assessmentContext(coherentModelState());
  for (const field of [
    "ubiquitousLanguage",
    "businessDecisions",
    "openQuestions",
    "assumptions",
    "inboundCommunication",
    "strategicClassification",
  ]) {
    ok(ctx.includes(field), `assessment context dropped ${field}`);
  }
  ok(ctx.includes("CANVAS REVISION:"), "assessment context states the reviewed revision");
});

test("assessmentDelay floors every arming path at the minimum interval", () => {
  const now = 1_000_000;
  // Cold start: nothing to wait for, so the debounce is honored as-is.
  strictEqual(assessmentDelay(1_500, 0, now), 1_500);
  // Evidence arriving inside the floor is deferred to when the floor opens, not dropped.
  strictEqual(assessmentDelay(1_500, now - 1_000, now), 59_000);
  // The periodic tick passes an explicit 0 to preempt a pending timer; it is floored too.
  strictEqual(assessmentDelay(0, now - 1_000, now), 59_000);
  // Floor already elapsed: back to the plain debounce.
  strictEqual(assessmentDelay(1_500, now - 90_000, now), 1_500);
});

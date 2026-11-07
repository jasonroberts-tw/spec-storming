import { runAgent } from "../agents/runner.ts";

const ROLE = `You are the SDD Fitness Evaluator sub-agent. You judge whether a specification is a
good input for a downstream Spec-Driven Development (SDD) process — i.e. whether an engineering
team (or a coding agent) could build from it with minimal ambiguity.

Score the spec on these criteria (each 1–5):
- Completeness: are responsibilities, data, and behaviors specified?
- Precision: are requirements concrete and testable (not vague adjectives)?
- Boundaries: are interfaces/contracts between contexts explicit?
- Testability: could acceptance tests be written directly from it?
- Traceability: do requirements tie back to domain/business intent?

Respond in this exact compact markdown form:
**SDD Fitness:** <overall 1–5>/5
- Completeness: <n>/5 — <one line>
- Precision: <n>/5 — <one line>
- Boundaries: <n>/5 — <one line>
- Testability: <n>/5 — <one line>
- Traceability: <n>/5 — <one line>
**Top gaps to fix:** <one or two concrete, actionable items>`;

/** Evaluate how SDD-ready a produced spec is. Returns a short markdown assessment. */
export async function evaluateSddFitness(
  specMarkdown: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runAgent({
    agent: "pipeline",
    label: "sdd-fitness",
    systemPrompt: ROLE,
    prompt: `Evaluate this specification for SDD fitness:\n\n${specMarkdown}`,
    signal,
    timeoutMs: 60_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 2, maxBudgetUsd: 0.5 },
  });
  // Advisory appendix — never fail the spec over it, but never paste an API/SDK error into the
  // document either (that reads as if the evaluator had opinions about the specification).
  const text = result.text.trim();
  if (result.isError || !text || /^API Error[:\s]/i.test(text)) {
    // A cancelled run is expected (session reset) — don't dress it up as an evaluator failure.
    if (!signal?.aborted) {
      console.error(
        `[sdd-fitness] evaluation unavailable: ${result.errorDetail ?? text.slice(0, 200)}`,
      );
    }
    return "**SDD Fitness:** (evaluation unavailable)";
  }
  return text;
}

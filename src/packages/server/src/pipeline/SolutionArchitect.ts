import type { SpecArtifact } from "@specstorming/shared";
import { loadSteering, requireAgentText, runAgentText } from "../agents/runner.ts";
import { evaluateSddFitness } from "./sddFitnessEvaluator.ts";

const ROLE = `You are the Solution Architect. Given the output of one or more EventStorming
sessions, you evaluate it from an architectural point of view and define the non-functional
requirements (NFRs).

Consider: messaging & integration patterns (sync vs async, choreography vs orchestration,
idempotency, ordering), resiliency strategies (timeouts, retries, circuit breakers, bulkheads,
graceful degradation), scaling & elasticity (stateless vs stateful, partitioning, caching,
back-pressure), data & consistency (strong vs eventual, aggregate consistency boundaries,
sagas/compensation), and observability.

Output GitHub-flavored markdown with a top-level "# Architecture Specification" heading, then:
- "## System-Wide NFRs" — NFRs that apply to the entire system, each SPECIFIC and TESTABLE
  (measurable targets, not adjectives), grouped by dimension (performance, resiliency,
  scalability, consistency, security, observability).
- "## Per-Bounded-Context NFRs" — a subsection per bounded context with NFRs specific to that
  context's load, criticality, and data (a core money context needs stronger guarantees than a
  generic notification context).
- "## Cross-Cutting Architecture Decisions" — messaging backbone, consistency model, key
  patterns, and any decisions that are hard to reverse, with trade-offs.

Make every NFR measurable (e.g. "p99 < 200ms at 500 rps", "no double-charge under retry").`;

/** Phase 2b: produce the architecture / NFR spec from the session artifact. */
export async function runSolutionArchitect(
  artifact: string,
  signal?: AbortSignal,
): Promise<SpecArtifact> {
  const steering = await loadSteering(["evolutionary-architecture"]);
  const result = await runAgentText({
    agent: "pipeline",
    label: "solution-architect",
    systemPrompt: `${ROLE}\n\n${steering}`,
    prompt: `Here is the EventStorming session artifact:\n\n${artifact}`,
    signal,
    timeoutMs: 150_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 4, maxBudgetUsd: 2 },
  });

  let markdown = requireAgentText(result, "Solution Architect");
  const fitness = await evaluateSddFitness(markdown, signal);
  markdown += `\n\n---\n\n## SDD Fitness Assessment\n\n${fitness}`;

  return {
    id: `spec-arch-${Date.now()}`,
    kind: "architecture",
    title: "Architecture Specification (NFRs)",
    markdown,
    createdAt: new Date().toISOString(),
  };
}

import type { SpecArtifact } from "@specstorming/shared";
import { loadSteering, requireAgentText, runAgentText } from "../agents/runner.ts";
import { evaluateSddFitness } from "./sddFitnessEvaluator.ts";

const ROLE = `You are the Boundary Analyzer. You pressure-test the bounded-context boundaries
discovered during EventStorming: resolve overlaps (assign a contested concept to the context
whose ubiquitous language owns it), and flag conflicts that need more data (don't invent
answers). Then produce a concise specification per bounded context, optimized as input for a
Spec-Driven Development process.

Output GitHub-flavored markdown: a "# Bounded Context Specifications" heading, then one
"## <Context>" section per context covering purpose & classification, ubiquitous language,
domain model (aggregates/events/commands/policies), responsibilities, interfaces (inbound/
outbound with the other context named), invariants, and a few concrete acceptance criteria.
Finish with "## Cross-Boundary Conflicts" (overlaps resolved + conflicts remaining). Be
concise but concrete — keep each context tight so the whole document stays focused.`;

/** Phase 2a: produce per-bounded-context specs from the session artifact. */
export async function runBoundaryAnalyzer(
  artifact: string,
  signal?: AbortSignal,
): Promise<SpecArtifact> {
  const steering = await loadSteering(["ddd", "evolutionary-architecture"]);
  const result = await runAgentText({
    agent: "pipeline",
    label: "boundary-analyzer",
    systemPrompt: `${ROLE}\n\n${steering}`,
    prompt: `Here is the EventStorming session artifact:\n\n${artifact}`,
    signal,
    timeoutMs: 150_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 4, maxBudgetUsd: 2 },
  });

  let markdown = requireAgentText(result, "Boundary Analyzer");
  const fitness = await evaluateSddFitness(markdown, signal);
  markdown += `\n\n---\n\n## SDD Fitness Assessment\n\n${fitness}`;

  return {
    id: `spec-bc-${Date.now()}`,
    kind: "bounded-context",
    title: "Bounded Context Specifications",
    markdown,
    createdAt: new Date().toISOString(),
  };
}

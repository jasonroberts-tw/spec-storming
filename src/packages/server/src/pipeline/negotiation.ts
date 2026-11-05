import type { SpecArtifact } from "@specstorming/shared";
import { loadSteering, requireAgentText, runAgentText } from "../agents/runner.ts";

const SYSTEM_SPEC_FORMAT = `The System Specification MUST use exactly these sections, in order:
1. Business value primer
2. System overview
3. Architectural patterns
4. State/persistence mechanisms
5. Communication mechanisms
6. System diagram (a Mermaid diagram in a \`\`\`mermaid code block)
7. External integrations
8. Standards (e.g. OpenTelemetry)
9. Bounded context definitions
10. Service definitions (hosting and scaling)
11. Functional requirements
12. Non-functional requirements

Keep each section concise (a few sentences or a tight list) — a focused, complete spec, not
an exhaustive one. Aim for the whole document to be readable in a few minutes.`;

const ARCHITECT_ROLE = `You are the System Architect. You read both the bounded-context specs
and the architecture spec and evaluate them from a systems and enterprise architecture
perspective. You collaborate with a Business/Product agent to produce a final System
Specification optimized as input for a downstream Spec-Driven Development process. When the
Business/Product agent raises a point outside your expertise (a pure business-priority call),
incorporate it; where it conflicts with a sound systems decision, push back with reasoning.`;

const PRODUCT_ROLE = `You are the Business/Product agent. You focus ONLY on the bounded-context
specs, evaluating them from a high-level business-requirements perspective: business value,
priorities, customer outcomes, risk/compliance, and traceability of requirements to value.
You pressure-test the System Architect's draft and insist that business-critical requirements
(e.g. never double-charge a customer) are explicit. Defer to the System Architect on pure
systems/enterprise trade-offs.`;

interface NegotiationInputs {
  boundedContextSpec: string;
  architectureSpec: string;
}

/**
 * Trim a spec to its first N chars so the negotiation's combined input + output stays within
 * the size where the model reliably produces a complete response. (Drops the trailing SDD
 * fitness footer, which the negotiation doesn't need.)
 */
function condense(spec: string, max = 7000): string {
  return spec.length <= max ? spec : `${spec.slice(0, max)}\n\n…(truncated)`;
}

/**
 * Phase 3: a bounded adversarial loop between the System Architect and the Business/Product
 * agent (A2A-style message exchange) that converges on the final System Specification.
 */
export async function runNegotiation(
  rawInputs: NegotiationInputs,
  signal?: AbortSignal,
): Promise<SpecArtifact> {
  const inputs: NegotiationInputs = {
    boundedContextSpec: condense(rawInputs.boundedContextSpec),
    architectureSpec: condense(rawInputs.architectureSpec),
  };
  const eaSteering = await loadSteering(["enterprise-architecture", "evolutionary-architecture"]);
  const bizSteering = await loadSteering(["business-goals"]);

  // Round 1 — System Architect drafts the System Spec.
  const draft = await runAgentText({
    agent: "pipeline",
    label: "negotiation:draft",
    systemPrompt: `${ARCHITECT_ROLE}\n\n${eaSteering}`,
    prompt: [
      "Produce a first draft of the System Specification from these inputs.",
      "",
      "## Bounded Context Specs\n" + inputs.boundedContextSpec,
      "",
      "## Architecture Spec\n" + inputs.architectureSpec,
      "",
      SYSTEM_SPEC_FORMAT,
    ].join("\n"),
    signal,
    timeoutMs: 150_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 4, maxBudgetUsd: 2 },
  });

  // Round 1 critique — Business/Product reviews from a business perspective.
  const critique = await runAgentText({
    agent: "pipeline",
    label: "negotiation:critique",
    systemPrompt: `${PRODUCT_ROLE}\n\n${bizSteering}`,
    prompt: [
      "The System Architect drafted this System Specification. Review it from a business and",
      "product perspective. List concrete concerns: missing business value, mis-prioritized",
      "requirements, business-critical rules not made explicit, and anything not traceable to",
      "value. Be specific and actionable. Do NOT rewrite the spec — just critique.",
      "",
      "## Bounded Context Specs (your reference)\n" + inputs.boundedContextSpec,
      "",
      "## Draft System Specification\n" + draft.text,
    ].join("\n"),
    signal,
    timeoutMs: 120_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 3, maxBudgetUsd: 1.5 },
  });

  // Round 2 — System Architect revises, resolving the critique (A2A mediation).
  const final = await runAgentText({
    agent: "pipeline",
    label: "negotiation:final",
    systemPrompt: `${ARCHITECT_ROLE}\n\n${eaSteering}`,
    prompt: [
      "Revise your System Specification to address the Business/Product agent's critique below.",
      "Incorporate valid business points; where a point conflicts with a sound systems decision,",
      "keep your decision and add a one-line rationale. Output the COMPLETE final spec.",
      "",
      SYSTEM_SPEC_FORMAT,
      "",
      "## Your draft\n" + draft.text,
      "",
      "## Business/Product critique to resolve\n" + critique.text,
    ].join("\n"),
    signal,
    timeoutMs: 180_000,
    options: { model: "claude-sonnet-5", tools: [], maxTurns: 4, maxBudgetUsd: 2.5 },
  });

  // Round 2 is the deliverable; fall back to the round-1 draft only if it is itself usable.
  let markdown: string;
  try {
    markdown = requireAgentText(final, "System Architect (round 2)");
  } catch (err) {
    markdown = requireAgentText(draft, "System Architect (draft)");
    console.error(`[negotiation] round 2 unusable, falling back to the draft: ${String(err)}`);
  }

  return {
    id: `spec-system-${Date.now()}`,
    kind: "system",
    title: "System Specification",
    markdown,
    createdAt: new Date().toISOString(),
  };
}

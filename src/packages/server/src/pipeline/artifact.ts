import type { SessionState } from "@specstorming/shared";

/**
 * Serialize the finished session (synthesized Canvas + transcript) into a single readable
 * markdown artifact — the input to the Phase 2/3 spec pipeline.
 */
export function serializeArtifact(state: SessionState): string {
  const { canvas } = state;

  const stickiesByContext = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const s of canvas.stickies) {
    const line = `- **${s.kind}**: ${s.text}${
      s.sourceChunkIds.length ? ` _(${s.sourceChunkIds.join(", ")})_` : ""
    }`;
    if (s.boundedContextId) {
      const arr = stickiesByContext.get(s.boundedContextId) ?? [];
      arr.push(line);
      stickiesByContext.set(s.boundedContextId, arr);
    } else {
      unassigned.push(line);
    }
  }

  const contexts = canvas.boundedContexts
    .map((b) => {
      const ul = b.ubiquitousLanguage.map((t) => `  - **${t.term}**: ${t.definition}`).join("\n");
      const inbound = b.inboundCommunication
        .map((m) => `  - ${m.name} ← ${m.party}${m.via ? ` (${m.via})` : ""}`)
        .join("\n");
      const outbound = b.outboundCommunication
        .map((m) => `  - ${m.name} → ${m.party}${m.via ? ` (${m.via})` : ""}`)
        .join("\n");
      const members = stickiesByContext.get(b.id) ?? [];
      return [
        `### ${b.name}  _(${b.strategicClassification.domain})_`,
        b.purpose,
        b.strategicClassification.businessModel
          ? `Business model: ${b.strategicClassification.businessModel}`
          : "",
        ul ? `Ubiquitous language:\n${ul}` : "",
        inbound ? `Inbound:\n${inbound}` : "",
        outbound ? `Outbound:\n${outbound}` : "",
        b.businessDecisions.length ? `Business decisions:\n${b.businessDecisions.map((d) => `  - ${d}`).join("\n")}` : "",
        b.assumptions.length ? `Assumptions:\n${b.assumptions.map((a) => `  - ${a}`).join("\n")}` : "",
        b.openQuestions.length ? `Open questions:\n${b.openQuestions.map((q) => `  - ${q}`).join("\n")}` : "",
        members.length ? `Model elements:\n${members.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");

  const hotspots = canvas.hotspots.map((h) => `- ${h.text}`).join("\n");

  return [
    `# EventStorming Session Artifact: ${state.title}`,
    `## Bounded Contexts\n\n${contexts || "_(none identified)_"}`,
    unassigned.length ? `## Unassigned model elements\n\n${unassigned.join("\n")}` : "",
    `## Hotspots / Unresolved Questions\n\n${hotspots || "_(none)_"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Phase 2–3 post-session pipeline: turns the finished session artifact into specs
 * optimized for spec-driven development.
 */

export type SpecKind = "bounded-context" | "architecture" | "system";

export interface SpecArtifact {
  id: string;
  kind: SpecKind;
  title: string;
  markdown: string;
  createdAt: string;
}

export type PipelineStage =
  | "idle"
  | "boundary-analysis" // Phase 2a: per-bounded-context specs
  | "architecture" // Phase 2b: architecture / NFR spec
  | "negotiation" // Phase 3: System Architect ↔ Business/Product
  | "done"
  | "error";

export interface PipelineState {
  stage: PipelineStage;
  detail?: string;
  artifacts: SpecArtifact[];
}

export function emptyPipeline(): PipelineState {
  return { stage: "idle", artifacts: [] };
}

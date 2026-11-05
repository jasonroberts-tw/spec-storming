import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PipelineStage, SpecArtifact, SpecKind } from "@specstorming/shared";

const STAGE_LABEL: Record<PipelineStage, string> = {
  idle: "Idle",
  "boundary-analysis": "Phase 2 — Boundary Analyzer: per-context specs…",
  architecture: "Phase 2 — Solution Architect: NFR / architecture spec…",
  negotiation: "Phase 3 — System Architect ↔ Business/Product negotiating…",
  done: "Pipeline complete",
  error: "Pipeline error",
};

const KIND_LABEL: Record<SpecKind, string> = {
  "bounded-context": "Bounded Context",
  architecture: "Architecture",
  system: "System",
};

function download(spec: SpecArtifact) {
  const blob = new Blob([spec.markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${spec.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SpecsPanel({
  specs,
  stage,
  detail,
  onClose,
}: {
  specs: SpecArtifact[];
  stage: PipelineStage;
  detail?: string;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId && specs.length > 0) setActiveId(specs[specs.length - 1].id);
  }, [specs, activeId]);

  const active = specs.find((s) => s.id === activeId) ?? null;
  const busy = stage !== "done" && stage !== "error" && stage !== "idle";

  return (
    <div className="specs-overlay">
      <div className="specs-header">
        <h2>System Specification Pipeline</h2>
        <div className={`pipeline-stage ${busy ? "busy" : stage}`}>
          {busy && <span className="spinner" />}
          {STAGE_LABEL[stage]}
          {detail && busy ? ` ${detail}` : ""}
        </div>
        <button className="specs-close" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      <div className="specs-body">
        <div className="specs-tabs">
          <div className="specs-tabs-title">
            Documents{specs.length > 0 ? ` · ${specs.length}` : ""}
          </div>
          {specs.length === 0 && <p className="empty">Waiting for the first spec…</p>}
          {specs.map((s) => (
            <button
              key={s.id}
              className={`spec-tab kind-${s.kind}${s.id === activeId ? " active" : ""}`}
              onClick={() => setActiveId(s.id)}
            >
              <span className="spec-tab-kind">{KIND_LABEL[s.kind]}</span>
              <span className="spec-tab-title">{s.title}</span>
            </button>
          ))}
        </div>
        <div className="spec-content">
          {active ? (
            <article key={active.id} className={`spec-doc kind-${active.kind}`}>
              <header className="spec-doc-head">
                <div>
                  <span className="spec-doc-kind">{KIND_LABEL[active.kind]}</span>
                  <span className="spec-doc-id">{active.id}.md</span>
                </div>
                <button onClick={() => download(active)}>⬇ Download .md</button>
              </header>
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{active.markdown}</Markdown>
              </div>
            </article>
          ) : (
            <p className="empty">The produced specifications will appear here.</p>
          )}
        </div>
      </div>
    </div>
  );
}

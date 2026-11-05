import { useEffect, useRef, useState } from "react";
import type { Canvas as CanvasType, Hint, StickyKind } from "@specstorming/shared";
import { Sticky } from "./Sticky.tsx";
import { BoundedContextCard } from "./BoundedContextCard.tsx";
import { HintChip } from "./HintChip.tsx";

// Rough EventStorming left-to-right reading order by sticky kind.
const COLUMN_ORDER: StickyKind[] = [
  "actor",
  "command",
  "aggregate",
  "domainEvent",
  "policy",
  "readModel",
  "externalSystem",
  "hotspot",
];

export function Canvas({
  canvas,
  revision,
  hints,
  onEngageHint,
  onDismissHint,
  board,
}: {
  canvas: CanvasType;
  revision: number;
  hints: Hint[];
  onEngageHint: (hint: Hint) => void;
  onDismissHint: (hint: Hint) => void;
  /** Replaces the sticky board (e.g. the Mural embed); hints/hotspots/BCC cards stay. */
  board?: React.ReactNode;
}) {
  // Track which stickies changed at the latest revision to flash them briefly.
  const prevRev = useRef(revision);
  useEffect(() => {
    prevRev.current = revision;
  }, [revision]);

  // Canvas element the hovered/focused hint concerns, highlighted while hovered.
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const sorted = [...canvas.stickies].sort((a, b) => {
    const ka = COLUMN_ORDER.indexOf(a.kind);
    const kb = COLUMN_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return (a.order ?? 0) - (b.order ?? 0);
  });

  return (
    <div className="pane canvas">
      <h2 className="pane-title">
        Canvas <span className="muted">rev {revision}</span>
      </h2>

      {board ?? (
        <div className="sticky-board">
          {sorted.length === 0 && (
            <p className="empty">The Synthesizer will fill this as the conversation unfolds…</p>
          )}
          {sorted.map((s) => (
            <Sticky
              key={s.id}
              sticky={s}
              fresh={s.updatedAtRev === canvas.lastUpdatedRev}
              highlighted={s.id === highlightId}
            />
          ))}
        </div>
      )}

      {hints.length > 0 && (
        <div className="hints-area">
          <h3>Coach hints</h3>
          {hints.map((h) => (
            <HintChip
              key={h.id}
              hint={h}
              onEngage={onEngageHint}
              onDismiss={onDismissHint}
              onHover={setHighlightId}
            />
          ))}
        </div>
      )}

      {canvas.hotspots.length > 0 && (
        <div className="hotspots">
          <h3>Hotspots</h3>
          <ul>
            {canvas.hotspots.map((h) => (
              <li key={h.id} className={h.id === highlightId ? "highlighted" : undefined}>
                {h.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canvas.boundedContexts.length > 0 && (
        <div className="bcc-panel">
          <h3>Bounded Contexts</h3>
          <div className="bcc-cards">
            {canvas.boundedContexts.map((bc) => (
              <div key={bc.id} className={bc.id === highlightId ? "bcc-highlight" : undefined}>
                <BoundedContextCard bc={bc} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

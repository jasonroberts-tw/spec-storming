import type { Hint } from "@specstorming/shared";

const KIND_LABEL: Record<string, string> = {
  "discuss-hotspot": "Hot spot",
  "clarify-ambiguity": "Clarify",
  "go-broader": "Go broader",
  "go-deeper": "Go deeper",
  "next-topic": "Next topic",
};

/**
 * A coach hint on the canvas: deliberately lighter than a sticky — outlined chip, not a
 * note — because hints are meta-guidance about the model, not part of it. New chips play
 * their entrance animation once on mount; unchanged hints keep their DOM node across
 * hints.updated events, so only genuinely new hints flash.
 */
export function HintChip({
  hint,
  onEngage,
  onDismiss,
  onHover,
}: {
  hint: Hint;
  onEngage: (hint: Hint) => void;
  onDismiss: (hint: Hint) => void;
  onHover: (targetId: string | null) => void;
}) {
  return (
    <div
      className={`hint-chip hint-${hint.kind}`}
      onMouseEnter={() => onHover(hint.targetId ?? null)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(hint.targetId ?? null)}
      onBlur={() => onHover(null)}
      tabIndex={0}
    >
      <span className="hint-kind">💡 {KIND_LABEL[hint.kind] ?? hint.kind}</span>
      <span className="hint-text">{hint.text}</span>
      <span className="hint-actions">
        <button className="hint-engage" onClick={() => onEngage(hint)} title="Take this to the Coach">
          Discuss
        </button>
        <button className="hint-dismiss" onClick={() => onDismiss(hint)} title="Dismiss this hint">
          ✕
        </button>
      </span>
    </div>
  );
}

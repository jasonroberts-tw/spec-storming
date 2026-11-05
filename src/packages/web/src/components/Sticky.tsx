import type { Sticky as StickyType } from "@specstorming/shared";

const KIND_LABEL: Record<string, string> = {
  domainEvent: "Event",
  command: "Command",
  actor: "Actor",
  policy: "Policy",
  readModel: "Read Model",
  externalSystem: "External",
  hotspot: "Hotspot",
  aggregate: "Aggregate",
};

export function Sticky({
  sticky,
  fresh,
  highlighted = false,
}: {
  sticky: StickyType;
  fresh: boolean;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`sticky kind-${sticky.kind} conf-${sticky.confidence}${fresh ? " fresh" : ""}${highlighted ? " highlighted" : ""}`}
      title={`${KIND_LABEL[sticky.kind] ?? sticky.kind} · confidence: ${sticky.confidence}`}
    >
      <span className="sticky-kind">{KIND_LABEL[sticky.kind] ?? sticky.kind}</span>
      <span className="sticky-text">{sticky.text}</span>
    </div>
  );
}

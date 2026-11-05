import type { BoundedContextCanvas } from "@specstorming/shared";

export function BoundedContextCard({ bc }: { bc: BoundedContextCanvas }) {
  return (
    <div className={`bcc-card domain-${bc.strategicClassification.domain}`}>
      <div className="bcc-head">
        <span className="bcc-name">{bc.name}</span>
        <span className="bcc-domain">{bc.strategicClassification.domain}</span>
      </div>
      <p className="bcc-purpose">{bc.purpose}</p>

      {bc.ubiquitousLanguage.length > 0 && (
        <div className="bcc-section">
          <h4>Ubiquitous Language</h4>
          <ul>
            {bc.ubiquitousLanguage.slice(0, 6).map((t) => (
              <li key={t.term}>
                <strong>{t.term}</strong>: {t.definition}
              </li>
            ))}
          </ul>
        </div>
      )}

      {bc.openQuestions.length > 0 && (
        <div className="bcc-section">
          <h4>Open Questions</h4>
          <ul>
            {bc.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * View-only Mural embed shown in place of the sticky board when a mural is bound.
 * Mural embeds are read-only iframes (no viewer login needed) — participants who
 * want to move stickies do it in the Mural app itself; the agent draws via the API.
 */
export function MuralEmbed({ embedUrl, degraded, detail }: {
  embedUrl: string;
  degraded: boolean;
  detail?: string;
}) {
  const tidy = async () => {
    try {
      await fetch("/api/mural/tidy", { method: "POST" });
    } catch {
      // status chip surfaces projector trouble; nothing to roll back
    }
  };

  return (
    <div className="mural-embed">
      <div className="mural-embed-bar">
        <span className="muted">
          Live Mural board{degraded ? ` — projection degraded${detail ? `: ${detail}` : ""}` : ""}
        </span>
        <span>
          {/* Blank/refused iframe means per-mural embedding isn't enabled (Share → Embed). */}
          <a href={embedUrl} target="_blank" rel="noreferrer" title="Open the board in Mural">
            ↗ Open in Mural
          </a>{" "}
          <button onClick={tidy} title="Recompute the whole board layout (moves widgets)">
            🧹 Tidy board
          </button>
        </span>
      </div>
      <iframe title="Mural board" src={embedUrl} className="mural-frame" />
    </div>
  );
}

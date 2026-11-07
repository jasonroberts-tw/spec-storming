import { useEffect, useRef } from "react";
import type { TranscriptChunk } from "@specstorming/shared";

export function TranscriptFeed({ transcript }: { transcript: TranscriptChunk[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length]);

  return (
    <div className="pane transcript">
      <h2 className="pane-title">Transcript</h2>
      <div className="transcript-list">
        {transcript.length === 0 && (
          <p className="empty">Press ▶ Start to replay the session…</p>
        )}
        {transcript.map((c) => (
          <div key={c.id} className="chunk">
            <span className="speaker">{c.speaker}</span>
            <span className="chunk-text">{c.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

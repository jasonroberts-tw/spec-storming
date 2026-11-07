import { useEffect, useState } from "react";

interface TranscriptOption {
  id: string;
  label: string;
  lineCount: number;
  estimatedSeconds: number;
}

interface TranscriptCatalog {
  selectedId: string;
  transcripts: TranscriptOption[];
}

export function TranscriptPicker({
  disabled,
}: {
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<TranscriptCatalog>({
    selectedId: "",
    transcripts: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcripts")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Transcript catalog failed (${response.status})`);
        return response.json() as Promise<TranscriptCatalog>;
      })
      .then((nextCatalog) => {
        if (!cancelled) setCatalog(nextCatalog);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Transcript catalog failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectTranscript = async (transcriptId: string) => {
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/session/replay/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcriptId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Transcript selection failed (${response.status})`);
      }
      setCatalog((current) => ({ ...current, selectedId: transcriptId }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Transcript selection failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <label className="transcript-picker">
      <span>Transcript</span>
      <select
        aria-label="Transcript"
        value={catalog.selectedId}
        disabled={disabled || loading || catalog.transcripts.length === 0}
        title={disabled ? "Reset the session before changing transcripts" : error || undefined}
        onChange={(event) => void selectTranscript(event.target.value)}
      >
        {catalog.transcripts.length === 0 ? (
          <option value="">{loading ? "Loading…" : "No transcripts found"}</option>
        ) : (
          catalog.transcripts.map((transcript) => (
            <option key={transcript.id} value={transcript.id}>
              {transcript.label}
            </option>
          ))
        )}
      </select>
      {error ? <span className="transcript-picker-error">{error}</span> : null}
    </label>
  );
}

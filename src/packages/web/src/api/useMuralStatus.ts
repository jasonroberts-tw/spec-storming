import { useCallback, useEffect, useState } from "react";

export interface MuralStatus {
  state: "unconfigured" | "disconnected" | "connected" | "bound" | "degraded";
  muralId?: string;
  embedUrl?: string;
  detail?: string;
}

/**
 * Mural connection/binding state, polled — it changes rarely (OAuth completes in
 * another tab, a bind happens once) so it isn't worth an SSE event type.
 */
export function useMuralStatus(pollMs = 15_000): MuralStatus & { refresh: () => void } {
  const [status, setStatus] = useState<MuralStatus>({ state: "unconfigured" });

  const refresh = useCallback(() => {
    void fetch("/api/mural/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: MuralStatus | null) => {
        if (s) setStatus(s);
      })
      .catch(() => {
        /* server not up yet; next poll retries */
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { ...status, refresh };
}

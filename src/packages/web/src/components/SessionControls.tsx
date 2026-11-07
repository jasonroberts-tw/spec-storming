import type { AgentName, LiveSourceState, PipelineStage } from "@specstorming/shared";
import type { AgentStatus } from "../api/useSessionStream.ts";
import type { MuralStatus } from "../api/useMuralStatus.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { TranscriptPicker } from "./TranscriptPicker.tsx";

/** POSTs and reports whether it worked. Callers that don't care may ignore the result. */
async function post(path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.ok;
  } catch {
    // server may not expose this route yet
    return false;
  }
}

/** Chip labels per background agent for each in-flight state. */
const AGENT_CHIP: Partial<Record<AgentName, { queued: string; running: string; failed: string }>> = {
  synthesizer: { queued: "synthesizer waiting…", running: "synthesizing…", failed: "synthesis failed" },
  hints: { queued: "hints waiting…", running: "looking for hints…", failed: "hint pass failed" },
};

/** Chip treatment per live-source state; `off` renders nothing. */
const LIVE_CHIP: Partial<Record<LiveSourceState, { label: string; className: string }>> = {
  waiting: { label: "🔴 zoom waiting…", className: "chip synth" },
  connected: { label: "🔴 zoom live", className: "chip ok" },
  disconnected: { label: "🔴 zoom disconnected", className: "chip down" },
};

export function SessionControls({
  activeScreen,
  onScreenChange,
  transcriptStarted,
  connected,
  agents,
  status,
  liveSource,
  pipelineStage,
  hasSpecs,
  onToggleSpecs,
  mural,
  onMuralConnect,
  onMuralBind,
  onReset,
}: {
  activeScreen: "canvas" | "coach";
  onScreenChange: (screen: "canvas" | "coach") => void;
  transcriptStarted: boolean;
  connected: boolean;
  agents: Partial<Record<AgentName, AgentStatus>>;
  status: "live" | "finished";
  liveSource: { state: LiveSourceState; detail?: string };
  pipelineStage: PipelineStage;
  hasSpecs: boolean;
  onToggleSpecs: () => void;
  mural: MuralStatus;
  onMuralConnect: () => void;
  onMuralBind: () => void;
  onReset?: () => void;
}) {
  const pipelineBusy =
    pipelineStage !== "idle" && pipelineStage !== "done" && pipelineStage !== "error";
  /** Is there anything a reset would actually throw away? Drives the confirm prompt. */
  const hasWork = transcriptStarted || hasSpecs;

  return (
    <header className="controls">
      <span className="brand">{PRODUCT_NAME}</span>
      <nav className="screen-nav" aria-label="Application screens">
        <button
          className={activeScreen === "canvas" ? "active" : undefined}
          aria-pressed={activeScreen === "canvas"}
          onClick={() => onScreenChange("canvas")}
        >
          Canvas
        </button>
        <button
          className={activeScreen === "coach" ? "active" : undefined}
          aria-pressed={activeScreen === "coach"}
          onClick={() => onScreenChange("coach")}
        >
          Coach
        </button>
      </nav>
      <TranscriptPicker
        disabled={transcriptStarted || liveSource.state === "connected" || status === "finished"}
      />
      <div className="control-buttons">
        <button
          onClick={() => post("/api/session/replay/start")}
          disabled={liveSource.state === "connected"}
          title={liveSource.state === "connected" ? "Replay is disabled while Zoom is live" : undefined}
        >
          ▶ Start
        </button>
        <button onClick={() => post("/api/session/replay/pause")}>⏸ Pause</button>
        <button onClick={() => post("/api/session/replay/window", { seconds: 30 })}>
          ▶ Next 30s
        </button>
        <button onClick={() => post("/api/session/replay/window", { seconds: 120 })}>
          ▶ Next 2m
        </button>
        {status !== "finished" && (
          <button onClick={() => post("/api/session/finish")}>⏹ Finish</button>
        )}
        {/* Always available: a live session that has gone wrong is exactly when you need it. */}
        <button
          onClick={async () => {
            if (
              hasWork &&
              !window.confirm(
                "Clear this session? The canvas, transcript, coach chat and generated specs will be lost.",
              )
            ) {
              return;
            }
            const ok = await post("/api/session/reset");
            if (!ok) window.alert("Reset failed — the session was not cleared.");
            onReset?.();
          }}
          title="Cancel all in-flight LLM calls, clear canvas and transcript, and unbind Mural so you can start a new session"
        >
          🔄 Start Over
        </button>
        <button
          onClick={() => post("/api/pipeline/run")}
          disabled={pipelineBusy}
          title="Build specs from the current canvas. Pauses replay and stops background synthesis, hints and reviews — press ▶ Start to resume the session."
        >
          ⚙ Generate Specs
        </button>
        {(hasSpecs || pipelineBusy) && (
          <button onClick={onToggleSpecs}>📄 Specs{pipelineBusy ? "…" : ""}</button>
        )}
        {mural.state === "disconnected" && (
          <button onClick={onMuralConnect} title="Authorize the Mural app (opens Mural)">
            🔗 Connect Mural
          </button>
        )}
        {mural.state === "connected" && (
          <button onClick={onMuralBind} title="Project the canvas onto a mural">
            🖼 Bind Mural…
          </button>
        )}
      </div>
      <div className="status-chips">
        {(Object.keys(AGENT_CHIP) as AgentName[]).map((name) => {
          const s = agents[name];
          const labels = AGENT_CHIP[name];
          if (!s || !labels || s.state === "done") return null;
          if (s.state === "failed") {
            return (
              <span key={name} className="chip down" title={s.detail}>
                {labels.failed}
              </span>
            );
          }
          return (
            <span key={name} className={`chip synth ${s.state}`}>
              {labels[s.state]}
            </span>
          );
        })}
        {pipelineBusy && <span className="chip synth">building specs…</span>}
        {LIVE_CHIP[liveSource.state] && (
          <span className={LIVE_CHIP[liveSource.state]!.className} title={liveSource.detail}>
            {LIVE_CHIP[liveSource.state]!.label}
          </span>
        )}
        {mural.state === "bound" && <span className="chip ok">🖼 mural live</span>}
        {mural.state === "degraded" && (
          <span className="chip down" title={mural.detail}>
            🖼 mural degraded
          </span>
        )}
        <span className={`chip ${connected ? "ok" : "down"}`}>
          {connected ? "connected" : "disconnected"}
        </span>
        <span className="chip">{status}</span>
      </div>
    </header>
  );
}

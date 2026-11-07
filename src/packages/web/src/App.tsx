import { useEffect, useState } from "react";
import type { ChatMessage, Hint } from "@specstorming/shared";
import { useSessionStream } from "./api/useSessionStream.ts";
import { useMuralStatus } from "./api/useMuralStatus.ts";
import { SessionControls } from "./components/SessionControls.tsx";
import { TranscriptFeed } from "./components/TranscriptFeed.tsx";
import { Canvas } from "./components/Canvas.tsx";
import { CoachChat } from "./components/CoachChat.tsx";
import { MuralEmbed } from "./components/MuralEmbed.tsx";
import { SpecsPanel } from "./components/SpecsPanel.tsx";
import { PRODUCT_NAME } from "./brand.ts";

type AppScreen = "canvas" | "coach";

function screenFromHash(): AppScreen {
  return window.location.hash === "#coach" ? "coach" : "canvas";
}

export function App() {
  const session = useSessionStream();
  const mural = useMuralStatus();
  const [showSpecs, setShowSpecs] = useState(false);
  const [activeScreen, setActiveScreen] = useState<AppScreen>(screenFromHash);

  useEffect(() => {
    const syncScreen = () => setActiveScreen(screenFromHash());
    window.addEventListener("hashchange", syncScreen);
    return () => window.removeEventListener("hashchange", syncScreen);
  }, []);

  useEffect(() => {
    document.title = `${PRODUCT_NAME} ${activeScreen === "coach" ? "Coach" : "Canvas"}`;
  }, [activeScreen]);

  const changeScreen = (screen: AppScreen) => {
    window.location.hash = screen;
    setActiveScreen(screen);
  };

  // Auto-open the specs panel as soon as the pipeline starts.
  useEffect(() => {
    if (session.pipelineStage !== "idle") setShowSpecs(true);
  }, [session.pipelineStage]);

  const [coachFocusSignal, setCoachFocusSignal] = useState(0);

  const sendCoachMessage = async (text: string) => {
    const msg: ChatMessage = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      text,
      ts: new Date().toISOString(),
    };
    session.addLocalCoachMessage(msg);
    session.beginCoachRequest(); // thinking bubble appears before the server responds
    try {
      await fetch("/api/coach/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      // coach route arrives on Day 3
    }
  };

  // Engaging a hint: show it in the chat as the facilitator's turn (the server records the
  // same message; user turns aren't broadcast), kick off the seeded coach reply, focus chat.
  const engageHint = async (hint: Hint) => {
    session.addLocalCoachMessage({
      id: `local-hint-${hint.id}`,
      role: "user",
      text: `💡 ${hint.text}`,
      ts: new Date().toISOString(),
    });
    session.beginCoachRequest();
    changeScreen("coach");
    setCoachFocusSignal((n) => n + 1);
    try {
      await fetch(`/api/hint/${encodeURIComponent(hint.id)}/engage`, { method: "POST" });
    } catch {
      // hint retirement arrives via hints.updated; nothing to roll back locally
    }
  };

  const dismissHint = async (hint: Hint) => {
    try {
      await fetch(`/api/hint/${encodeURIComponent(hint.id)}/dismiss`, { method: "POST" });
    } catch {
      // ignore; the chip stays until a hints.updated confirms
    }
  };

  // Bind flow is deliberately minimal: paste the mural id from its URL.
  const bindMural = async () => {
    const muralId = window.prompt("Paste the mural's URL (or its id, e.g. workspace.12345):")?.trim();
    if (!muralId) return;
    try {
      const res = await fetch("/api/mural/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muralId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        window.alert(`Bind failed: ${body?.error ?? res.status}`);
      }
    } finally {
      mural.refresh();
    }
  };

  const muralBound = mural.state === "bound" || mural.state === "degraded";

  return (
    <div className="app">
      <SessionControls
        activeScreen={activeScreen}
        onScreenChange={changeScreen}
        transcriptStarted={session.transcript.length > 0}
        connected={session.connected}
        agents={session.agents}
        status={session.status}
        liveSource={session.liveSource}
        pipelineStage={session.pipelineStage}
        hasSpecs={session.specs.length > 0}
        onToggleSpecs={() => setShowSpecs((v) => !v)}
        mural={mural}
        onMuralConnect={() => window.open("/api/mural/connect", "_blank")}
        onMuralBind={bindMural}
        onReset={() => {
          // showSpecs is local state, so a reset would otherwise leave an empty specs drawer
          // open over the fresh session.
          setShowSpecs(false);
          mural.refresh();
        }}
      />
      {activeScreen === "canvas" ? (
        <main className="panes canvas-screen">
          <TranscriptFeed transcript={session.transcript} />
          <Canvas
            canvas={session.canvas}
            revision={session.revision}
            hints={session.hints}
            onEngageHint={engageHint}
            onDismissHint={dismissHint}
            board={
              muralBound && mural.embedUrl ? (
                <MuralEmbed
                  embedUrl={mural.embedUrl}
                  degraded={mural.state === "degraded"}
                  detail={mural.detail}
                />
              ) : undefined
            }
          />
        </main>
      ) : (
        <main className="coach-screen">
          <CoachChat
            messages={session.coachChat}
            onSend={sendCoachMessage}
            disabled={!session.connected}
            pending={session.coachPending}
            error={session.coachError}
            focusSignal={coachFocusSignal}
          />
        </main>
      )}
      {showSpecs && (
        <SpecsPanel
          specs={session.specs}
          stage={session.pipelineStage}
          detail={session.pipelineDetail}
          onClose={() => setShowSpecs(false)}
        />
      )}
    </div>
  );
}

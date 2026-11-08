import { useEffect, useReducer, useRef, useState } from "react";
import type { ChatMessage, ServerEvent } from "@specstorming/shared";
import type { SessionView } from "./sessionReducer.ts";
import { initialView, mergeChat, reducer } from "./sessionReducer.ts";

// Components import these types from here; the reducer's module is where they live.
export type { AgentStatus, SessionView } from "./sessionReducer.ts";

/** Subscribes to the server SSE stream and reduces events into a view model. */
export function useSessionStream(): SessionView & {
  addLocalCoachMessage: (m: ChatMessage) => void;
  /** Call when a coach request is submitted so the chat can show a thinking bubble at once. */
  beginCoachRequest: () => void;
} {
  const [view, dispatch] = useReducer(reducer, initialView);
  const [, force] = useState(0);
  const localRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => dispatch({ type: "connected", value: true });
    source.onerror = () => dispatch({ type: "connected", value: false });
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as ServerEvent;
        // localRef holds optimistic local turns and is merged in AFTER reduction, so the
        // reducer's session.reset branch can't clear it — the old session's user messages
        // would survive the reset. Drop them here.
        if (event.type === "session.reset") localRef.current = [];
        dispatch({ type: "event", event });
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, []);

  // Optimistically render the user's own messages before the server echoes them.
  const addLocalCoachMessage = (m: ChatMessage) => {
    localRef.current = [...localRef.current, m];
    force((n) => n + 1);
  };

  const beginCoachRequest = () => dispatch({ type: "coach.begin" });

  return {
    ...view,
    coachChat: mergeChat(localRef.current, view.coachChat),
    addLocalCoachMessage,
    beginCoachRequest,
  };
}

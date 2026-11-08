import type {
  AgentName,
  AgentRunState,
  Canvas,
  ChatMessage,
  Hint,
  LiveSourceState,
  PipelineStage,
  ServerEvent,
  SpecArtifact,
  TranscriptChunk,
} from "@specstorming/shared";
import { emptyCanvas } from "@specstorming/shared";

/**
 * The pure half of `useSessionStream`: the view model, the reducer that folds server events
 * into it, and the merge of optimistic local chat turns. It imports no React and touches no
 * DOM, so `node --test` can load it.
 */

export interface AgentStatus {
  state: AgentRunState;
  detail?: string;
}

export interface SessionView {
  connected: boolean;
  transcript: TranscriptChunk[];
  canvas: Canvas;
  revision: number;
  coachChat: ChatMessage[];
  hints: Hint[];
  agents: Partial<Record<AgentName, AgentStatus>>;
  /** True between submitting a coach request and its first streamed token. */
  coachPending: boolean;
  /** Set when the last coach run failed before producing a reply. */
  coachError?: string;
  status: "live" | "finished";
  liveSource: { state: LiveSourceState; detail?: string };
  pipelineStage: PipelineStage;
  pipelineDetail?: string;
  specs: SpecArtifact[];
}

export const initialView: SessionView = {
  connected: false,
  transcript: [],
  canvas: emptyCanvas(),
  revision: 0,
  coachChat: [],
  hints: [],
  agents: {},
  coachPending: false,
  status: "live",
  liveSource: { state: "off" },
  pipelineStage: "idle",
  specs: [],
};

export type Action =
  | { type: "connected"; value: boolean }
  | { type: "coach.begin" }
  | { type: "event"; event: ServerEvent };

export function reducer(state: SessionView, action: Action): SessionView {
  if (action.type === "connected") return { ...state, connected: action.value };
  if (action.type === "coach.begin") return { ...state, coachPending: true, coachError: undefined };

  const e = action.event;
  switch (e.type) {
    case "transcript.chunk":
      return { ...state, transcript: [...state.transcript, e.chunk] };
    case "canvas.updated":
      return { ...state, canvas: e.canvas, revision: e.revision };
    case "hints.updated":
      return { ...state, hints: e.hints };
    case "agent.status": {
      const next: SessionView = {
        ...state,
        agents: { ...state.agents, [e.agent]: { state: e.state, detail: e.detail } },
      };
      if (e.agent === "coach" && e.state === "failed") {
        next.coachPending = false;
        next.coachError = e.detail ? `The coach couldn't reply (${e.detail}).` : "The coach couldn't reply.";
      }
      return next;
    }
    case "session.status":
      return { ...state, status: e.status };
    case "live.status":
      return { ...state, liveSource: { state: e.state, detail: e.detail } };
    case "pipeline.status":
      return { ...state, pipelineStage: e.stage, pipelineDetail: e.detail };
    case "spec.produced":
      return state.specs.some((s) => s.id === e.artifact.id)
        ? state
        : { ...state, specs: [...state.specs, e.artifact] };
    case "coach.delta": {
      const existing = state.coachChat.find((m) => m.id === e.messageId);
      if (existing) {
        return {
          ...state,
          coachChat: state.coachChat.map((m) =>
            m.id === e.messageId ? { ...m, text: m.text + e.text } : m,
          ),
        };
      }
      return {
        ...state,
        // A proactive assessment is not an answer to the user's question — leave their
        // thinking bubble alone or it disappears mid-reply.
        coachPending: e.kind === "assessment" ? state.coachPending : false,
        coachChat: [
          ...state.coachChat,
          {
            id: e.messageId,
            role: "coach",
            text: e.text,
            ts: new Date().toISOString(),
            kind: e.kind,
            canvasRevision: e.canvasRevision,
          },
        ],
      };
    }
    case "coach.done":
      return {
        ...state,
        coachPending: e.message.kind === "assessment" ? state.coachPending : false,
        coachChat: state.coachChat.some((m) => m.id === e.message.id)
          ? state.coachChat.map((m) => (m.id === e.message.id ? e.message : m))
          : [...state.coachChat, e.message],
      };
    case "session.reset":
      // hydrate() re-emits the new session's state, but transcript/chat only ever append —
      // they must be dropped explicitly or the previous run's lines survive the reset.
      return { ...initialView, connected: state.connected };
    default:
      return state;
  }
}

/**
 * The chat the UI shows: the optimistic local turns and the server's messages, one per id, in
 * timestamp order. When both hold an id, the local turn is the one kept.
 */
export function mergeChat(local: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  return [...local, ...server]
    .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

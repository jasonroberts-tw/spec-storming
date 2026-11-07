import type { Canvas } from "./canvas.ts";
import type { Hint } from "./hints.ts";
import type {
  ChatMessage,
  ChatMessageKind,
  SessionStatus,
  TranscriptChunk,
} from "./session.ts";
import type { PipelineStage, SpecArtifact } from "./pipeline.ts";

/** Agents whose runs are serialized through the server's scheduler. `coach` is the
 * facilitator-triggered chat reply; `assessment` is the Coach's proactive deep review. They are
 * distinct identities because they differ in scheduling priority and because a failed `coach`
 * run is what the client turns into an inline chat error. */
export type AgentName = "synthesizer" | "coach" | "hints" | "pipeline" | "assessment";

/** Lifecycle of a single agent run: waiting in queue, executing, settled. */
export type AgentRunState = "queued" | "running" | "done" | "failed";

/** Connection state of the live transcript source (Zoom RTMS). */
export type LiveSourceState = "off" | "waiting" | "connected" | "disconnected";

/** Server → client events, delivered over a single SSE stream. */
export type ServerEvent =
  | { type: "hello"; sessionId: string; revision: number }
  | { type: "heartbeat"; ts: string }
  | { type: "transcript.chunk"; chunk: TranscriptChunk }
  | { type: "canvas.updated"; canvas: Canvas; revision: number }
  | { type: "hints.updated"; hints: Hint[] }
  | {
      type: "coach.delta";
      messageId: string;
      text: string;
      kind?: ChatMessageKind;
      canvasRevision?: number;
    }
  | { type: "coach.done"; message: ChatMessage }
  | { type: "agent.status"; agent: AgentName; state: AgentRunState; detail?: string }
  | { type: "session.status"; status: SessionStatus }
  /** The session was cleared back to empty; clients must discard all accumulated state. */
  | { type: "session.reset" }
  | { type: "live.status"; state: LiveSourceState; detail?: string }
  | { type: "pipeline.status"; stage: PipelineStage; detail?: string }
  | { type: "spec.produced"; artifact: SpecArtifact };

export type ServerEventType = ServerEvent["type"];

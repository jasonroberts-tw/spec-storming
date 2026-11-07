import type { Canvas } from "./canvas.ts";
import { emptyCanvas } from "./canvas.ts";
import type { Hint } from "./hints.ts";
import type { MuralProjectionState } from "./mural.ts";

export type ISO = string;

/** A single line of the streaming meeting transcript (raw input, append-only). */
export interface TranscriptChunk {
  id: string; // e.g. "t-0001"
  ts: ISO;
  speaker: string; // "Facilitator", "Dev-Anya", "PO-Sam", …
  text: string;
  seq: number; // monotonic ordering
}

export type DocKind = "notes" | "diagram" | "requirements";

/** A shared document brought into the session (raw input). */
export interface SessionDoc {
  id: string;
  title: string;
  kind: DocKind;
  content: string; // markdown / mermaid / plain
  updatedAt: ISO;
}

export type ChatRole = "user" | "coach";
export type ChatMessageKind = "conversation" | "assessment";
export type CoachFeedbackTone = "positive" | "constructive";
export type ModelMaturity = "Emerging" | "Developing" | "Coherent";

export interface CoachFeedback {
  tone: CoachFeedbackTone;
  title: string;
  summary: string;
  detail: string;
}

export interface ModelAssessment {
  score: number;
  maturity: ModelMaturity;
  summary: string;
  scoreRationale: string;
  feedback: CoachFeedback[];
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: ISO;
  /** Distinguishes proactive model reviews from the normal facilitator conversation. */
  kind?: ChatMessageKind;
  /** Canvas revision reviewed by a proactive assessment. */
  canvasRevision?: number;
  /** Latest transcript sequence included in a proactive assessment. */
  transcriptSeq?: number;
  /** Structured payload used by the completeness meter and compact feedback UI. */
  assessment?: ModelAssessment;
}

export type SessionStatus = "live" | "finished";

export interface SessionState {
  id: string;
  title: string;
  status: SessionStatus;

  // RAW INPUTS (append-only)
  transcript: TranscriptChunk[];
  docs: SessionDoc[];

  // SYNTHESIZED KNOWLEDGE (only the Synthesizer writes this)
  canvas: Canvas;

  // COACH conversation (its own channel of raw input)
  coachChat: ChatMessage[];

  // COACH HINTS (unprompted guidance; the HintAgent writes these, never the canvas)
  hints: Hint[];

  // MURAL PROJECTION (optional; absent until a mural is bound to the session)
  mural?: MuralProjectionState;

  // bookkeeping
  lastSynthesizedSeq: number;
  revision: number; // bumps on any canvas write → drives UI diff
}

export function emptySession(id: string, title: string): SessionState {
  return {
    id,
    title,
    status: "live",
    transcript: [],
    docs: [],
    canvas: emptyCanvas(),
    coachChat: [],
    hints: [],
    lastSynthesizedSeq: 0,
    revision: 0,
  };
}

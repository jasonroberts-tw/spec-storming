import type { ISO } from "./session.ts";

/**
 * Coach Hints: unprompted guidance about the workshop, generated in the background and
 * shown on the canvas. Hints are NOT canvas content — the Synthesizer stays the sole
 * writer of stickies/contexts/hotspots; hints live beside the canvas in session state.
 */

export type HintKind =
  | "discuss-hotspot" // an unresolved hotspot deserves the room's attention
  | "clarify-ambiguity" // a term or flow means different things to different people
  | "go-broader" // an unexplored area of the domain
  | "go-deeper" // a thin area worth drilling into
  | "next-topic"; // suggested next thing to talk about

export const HINT_KINDS: HintKind[] = [
  "discuss-hotspot",
  "clarify-ambiguity",
  "go-broader",
  "go-deeper",
  "next-topic",
];

export type HintStatus = "active" | "engaged" | "dismissed";

export interface Hint {
  id: string; // stable kebab-case, used for dedupe
  kind: HintKind;
  /** Short imperative guidance shown on the canvas. */
  text: string;
  /** Pre-authored seed used when the hint is engaged in coach chat. */
  prompt: string;
  /** Sticky / hotspot / bounded-context id this hint concerns, if any. */
  targetId?: string;
  sourceChunkIds?: string[];
  status: HintStatus;
  createdTs: ISO;
}

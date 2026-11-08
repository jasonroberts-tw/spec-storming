import type { ChatMessage } from "@specstorming/shared";

/**
 * The pure helpers behind `CoachChat`'s completeness meter. They import no React, so
 * `node --test` can load them.
 */

/** The colour band of a 0–10 completeness score: up to 3 is low, up to 7 medium, above that complete. */
export function scoreBand(score: number) {
  if (score <= 3) return "low";
  if (score <= 7) return "medium";
  return "complete";
}

/**
 * Picks the freshest assessment by what it reviewed, not by array position: the rolling
 * provisional assessment keeps its original slot when it refreshes in place, so a later deep
 * review would lose a positional comparison. Ties go to the deep review over the provisional.
 */
export function latestAssessmentMessage(messages: ChatMessage[]) {
  const isProvisional = (m: ChatMessage) => m.id.startsWith("assessment-provisional-");
  let best: ChatMessage | undefined;
  for (const message of messages) {
    if (message.kind !== "assessment") continue;
    if (!best) {
      best = message;
      continue;
    }
    const rev = (m: ChatMessage) => m.canvasRevision ?? 0;
    const seq = (m: ChatMessage) => m.transcriptSeq ?? 0;
    const fresher =
      rev(message) !== rev(best)
        ? rev(message) > rev(best)
        : seq(message) !== seq(best)
          ? seq(message) > seq(best)
          : isProvisional(best) && !isProvisional(message);
    if (fresher) best = message;
  }
  return best;
}

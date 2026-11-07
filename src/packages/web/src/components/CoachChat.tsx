import { useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  CoachFeedback,
  ModelAssessment,
} from "@specstorming/shared";

function inlineMarkup(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

function CoachContent({ text }: { text: string }) {
  if (!text) return <div>…</div>;
  return (
    <div className="coach-content">
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} className="coach-spacer" />;
        if (trimmed === "---") return <hr key={index} />;
        if (trimmed.startsWith("### ")) {
          return <h3 key={index}>{inlineMarkup(trimmed.slice(4))}</h3>;
        }
        const bullet = trimmed.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={index} className="coach-bullet">
              <span aria-hidden="true">•</span>
              <span>{inlineMarkup(bullet[1])}</span>
            </div>
          );
        }
        const numbered = trimmed.match(/^(\d+)\.\s+(.+)$/);
        if (numbered) {
          return (
            <div key={index} className="coach-bullet">
              <span>{numbered[1]}.</span>
              <span>{inlineMarkup(numbered[2])}</span>
            </div>
          );
        }
        return <p key={index}>{inlineMarkup(trimmed)}</p>;
      })}
    </div>
  );
}

function scoreBand(score: number) {
  if (score <= 3) return "low";
  if (score <= 7) return "medium";
  return "complete";
}

function ModelCompletenessPanel({
  assessment,
}: {
  assessment?: ModelAssessment;
}) {
  const score = assessment?.score ?? 0;
  return (
    <section className="model-completeness" aria-labelledby="model-completeness-title">
      <div className="completeness-heading">
        <div>
          <h2 id="model-completeness-title">MODEL COMPLETENESS SCORE</h2>
          <p>{assessment?.maturity ?? "Awaiting assessment"}</p>
        </div>
        <strong className={`completeness-score ${scoreBand(score)}`}>
          {assessment ? score : "–"}
          <span>/10</span>
        </strong>
      </div>
      <div
        className="completeness-track"
        role="progressbar"
        aria-label="Model completeness"
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={assessment ? score : undefined}
      >
        <div
          className={`completeness-fill ${scoreBand(score)}`}
          style={{ width: `${score * 10}%` }}
        />
      </div>
      <div className="completeness-scale" aria-hidden="true">
        <span>0</span>
        <span>10</span>
      </div>
      <p className="completeness-summary">
        {assessment?.summary ?? "The score appears after the first stable Canvas review."}
      </p>
    </section>
  );
}

function FeedbackItem({ feedback }: { feedback: CoachFeedback }) {
  return (
    <article className={`feedback-item ${feedback.tone}`}>
      <div className="feedback-heading">
        <span
          className={`feedback-arrow ${feedback.tone}`}
          aria-label={`${feedback.tone === "positive" ? "Positive" : "Constructive"} feedback`}
        >
          {feedback.tone === "positive" ? "↑" : "↓"}
        </span>
        <strong>{feedback.title}</strong>
      </div>
      <p>{feedback.summary}</p>
      <details>
        <summary>More information</summary>
        <p>{feedback.detail}</p>
      </details>
    </article>
  );
}

function AssessmentFeedback({ assessment }: { assessment: ModelAssessment }) {
  return (
    <div className="assessment-feedback">
      {assessment.feedback.map((feedback, index) => (
        <FeedbackItem
          key={`${feedback.tone}-${feedback.title}-${index}`}
          feedback={feedback}
        />
      ))}
    </div>
  );
}

/**
 * Picks the freshest assessment by what it reviewed, not by array position: the rolling
 * provisional assessment keeps its original slot when it refreshes in place, so a later deep
 * review would lose a positional comparison. Ties go to the deep review over the provisional.
 */
function latestAssessmentMessage(messages: ChatMessage[]) {
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

export function CoachChat({
  messages,
  onSend,
  disabled,
  pending = false,
  error,
  focusSignal = 0,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled: boolean;
  /** True while a coach reply is queued/starting — shows a thinking bubble immediately. */
  pending?: boolean;
  /** Set when the last coach run failed before replying — shown inline; sending again retries. */
  error?: string;
  /** Bump to pull focus into the chat input (e.g. when a canvas hint is engaged). */
  focusSignal?: number;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestAssessment = latestAssessmentMessage(messages);
  const visibleMessages = latestAssessment
    ? messages.filter(
        (message) =>
          message.kind !== "assessment" || message.id === latestAssessment.id,
      )
    : messages;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, error]);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="coach-workspace">
      <ModelCompletenessPanel assessment={latestAssessment?.assessment} />
      <section className="pane coach coach-feedback-panel" aria-labelledby="coach-title">
        <h2 id="coach-title" className="pane-title">Coach</h2>
        <div className="coach-list">
          {visibleMessages.length === 0 ? (
            <p className="empty">
              The Coach will assess the Canvas as it develops. You can also ask about gaps,
              history, or DDD/EventStorming advice.
            </p>
          ) : null}
          {visibleMessages.map((message) => (
            <div
              key={message.id}
              className={`bubble ${message.role} ${message.kind ?? "conversation"}`}
            >
              {message.assessment ? (
                <AssessmentFeedback assessment={message.assessment} />
              ) : message.kind === "assessment" ? (
                <details className="legacy-assessment">
                  <summary>View previous assessment</summary>
                  <CoachContent text={message.text} />
                </details>
              ) : (
                <CoachContent text={message.text} />
              )}
            </div>
          ))}
          {pending && (
            <div className="bubble coach pending" aria-live="polite">
              <span className="thinking">thinking…</span>
            </div>
          )}
          {error && !pending && (
            <div className="bubble coach error">
              {error} Send your question again to retry.
            </div>
          )}
          <div ref={endRef} />
        </div>
      </section>
      <section className="coach-question-panel" aria-labelledby="coach-question-title">
        <h2 id="coach-question-title" className="pane-title">Ask the Coach</h2>
        <div className="coach-input">
          <textarea
            ref={inputRef}
            value={draft}
            placeholder="What gaps do we have so far?"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button onClick={submit} disabled={disabled || draft.trim().length === 0}>
            Send
          </button>
        </div>
      </section>
    </div>
  );
}

import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ModelAssessment,
  ServerEvent,
  SessionState,
} from "@specstorming/shared";
import { z } from "zod";
import type { EventBus } from "../bus/EventBus.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";
import { AGENTS, COACH_CONFIG } from "../config.ts";
import { withSpan } from "../observability/tracing.ts";
import { loadSteering, runAgent } from "./runner.ts";

const ROLE = `You are the Coach in a live EventStorming session. The facilitator chats with you
directly. You answer questions about the conversation so far, point out gaps and missing
elements, surface vagueness and unstated assumptions, and give practical EventStorming and
Domain-Driven Design advice.

Ground every answer in the ACTUAL session content provided below — cite specific events,
commands, contexts, or speakers. Be concise and concrete (a few short paragraphs or a tight
list). If asked "what gaps do we have", name specific missing pieces (e.g. an event with no
command, a policy with no trigger, an unmodeled failure path, an undefined boundary). You give
advice only; you never modify the Canvas.`;

/** The assessment method, appended to the system prompt of proactive reviews only: its JSON-only
 * response contract would otherwise leak into chat replies. */
const ASSESSMENT_STEERING = ["assess-domain-model", "domain-model-quality"];

const PROVISIONAL_ID_PREFIX = "assessment-provisional-";
/**
 * A single stable id, so each refresh replaces the previous provisional in place rather than
 * appending one message per canvas revision — coachChat is persisted and replayed in full to
 * every reconnecting SSE client, and only the newest provisional is ever displayed.
 */
const PROVISIONAL_ID = `${PROVISIONAL_ID_PREFIX}current`;

const modelAssessmentSchema = z
  .object({
    score: z.number().int().min(0).max(10),
    maturity: z.enum(["Emerging", "Developing", "Coherent"]),
    summary: z.string().min(1).max(200),
    scoreRationale: z.string().min(1),
    feedback: z
      .array(
        z.object({
          tone: z.enum(["positive", "constructive"]),
          title: z.string().min(1).max(120),
          summary: z.string().min(1).max(200),
          detail: z.string().min(1),
        }),
      )
      .min(2)
      .max(4),
  })
  .superRefine((assessment, context) => {
    const tones = new Set(assessment.feedback.map((item) => item.tone));
    if (!tones.has("positive") || !tones.has("constructive")) {
      context.addIssue({
        code: "custom",
        path: ["feedback"],
        message: "feedback must include positive and constructive items",
      });
    }
  });

function parseModelAssessment(text: string): ModelAssessment | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const candidate =
    fenced ??
    (firstBrace >= 0 && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : text);
  try {
    const parsed: unknown = JSON.parse(candidate);
    const result = modelAssessmentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Recent transcript lines included verbatim; older history reaches the Coach only through
 * the canvas summary. Keeps prompt size — and time-to-first-token — flat over long sessions. */
const TRANSCRIPT_WINDOW = 30;

/**
 * The transcript window both Coach prompts share. The "N earlier lines omitted" note is part of
 * the contract, not decoration: without it the model reads a truncated transcript as the whole
 * session and reports missing evidence that exists but was cut.
 */
function transcriptBlock(state: SessionState, label: string): string {
  const recent = state.transcript
    .slice(-TRANSCRIPT_WINDOW)
    .map((c) => `[${c.id}] ${c.speaker}: ${c.text}`)
    .join("\n");
  const omitted = Math.max(0, state.transcript.length - TRANSCRIPT_WINDOW);
  const note = omitted
    ? `; ${omitted} earlier lines omitted — the canvas above summarizes them`
    : "";
  return `${label} (last ${TRANSCRIPT_WINDOW} lines${note}):\n${recent || "(empty)"}`;
}

/**
 * Bounded transcript + canvas context the Coach reasons over: a fixed window of recent
 * transcript, per-context sticky labels, and full text for hotspots and unplaced stickies.
 * Exported for tests (prompt size must stay flat as the transcript grows).
 */
export function sessionContext(state: SessionState): string {
  const canvas = state.canvas;
  const byContext = canvas.boundedContexts
    .map((b) => {
      const stickies = canvas.stickies.filter((s) => s.boundedContextId === b.id);
      const labels = stickies.map((s) => `  - ${s.id} [${s.kind}] ${s.text}`).join("\n");
      return [
        `${b.name} (${b.strategicClassification.domain}): ${b.purpose} — ${stickies.length} stickies`,
        labels,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  const unplaced = canvas.stickies
    .filter((s) => !s.boundedContextId)
    .map((s) => `${s.id} [${s.kind}] ${s.text}`)
    .join("\n");
  const hotspots = canvas.hotspots.map((h) => `- ${h.text}`).join("\n");
  return [
    `BOUNDED CONTEXTS (${canvas.boundedContexts.length}):\n${byContext || "(none yet)"}`,
    `UNPLACED STICKIES:\n${unplaced || "(none)"}`,
    `HOTSPOTS / OPEN QUESTIONS:\n${hotspots || "(none yet)"}`,
    transcriptBlock(state, "RECENT TRANSCRIPT"),
  ].join("\n\n");
}

function recentChat(chat: ChatMessage[], n = 6): string {
  return chat
    .slice(-n)
    .map((m) => `${m.role === "user" ? "Facilitator" : "Coach"}: ${m.text}`)
    .join("\n");
}

/**
 * Assessment prompt context. Unlike sessionContext this keeps the FULL canvas: the
 * assess-domain-model skill scores ubiquitousLanguage, businessDecisions, assumptions,
 * openQuestions and in/outbound communication, all of which sessionContext's structural summary
 * drops. The canvas grows with model size, not session length, so it stays bounded; the
 * transcript does not, so it is windowed exactly the way the interactive path windows it.
 * Exported for tests (prompt size must stay flat as the transcript grows).
 */
export function assessmentContext(state: SessionState): string {
  return [
    `CANVAS REVISION: ${state.revision}`,
    `CANVAS:\n${JSON.stringify(state.canvas, null, 2)}`,
    transcriptBlock(state, "TRANSCRIPT EVIDENCE"),
  ].join("\n\n");
}

/**
 * Delay before the next deep review may start: the requested delay, pushed out to whatever
 * remains of the minimum interval. Deferring rather than rejecting matters — a rejected trigger
 * loses its evidence until some later unrelated event fires, while a deferred one runs the moment
 * the floor opens, against freshly re-read state. Exported for tests.
 */
export function assessmentDelay(
  requestedMs: number,
  lastAssessmentAt: number,
  now: number,
): number {
  return Math.max(requestedMs, lastAssessmentAt + COACH_CONFIG.assessmentMinIntervalMs - now, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Math.min(numerator / denominator, 1);
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Fast deterministic coherence signal shown while the deeper model review is queued.
 * It intentionally rewards connected behavior, ownership, rules, language, exceptions, and
 * evidence—not raw sticky volume. The skill performs the deeper semantic review.
 */
export function provisionalAssessment(state: SessionState): ModelAssessment {
  const stickies = state.canvas.stickies;
  const count = (kind: (typeof stickies)[number]["kind"]) =>
    stickies.filter((sticky) => sticky.kind === kind).length;
  const events = count("domainEvent");
  const commands = count("command");
  const actors = count("actor");
  const policies = count("policy");
  const aggregates = count("aggregate");
  const readModels = count("readModel");
  const externalSystems = count("externalSystem");
  const contexts = state.canvas.boundedContexts;
  const hotspots = state.canvas.hotspots.length;

  const contextStickies = contexts.map((context) =>
    stickies.filter((sticky) => sticky.boundedContextId === context.id),
  );
  const behavioralFlow = average(
    contextStickies.map((items) => {
      const kinds = new Set(items.map((item) => item.kind));
      const commandsInContext = items.filter((item) => item.kind === "command");
      const eventsInContext = items.filter((item) => item.kind === "domainEvent");
      const hasCausalOrder = commandsInContext.some((command) =>
        eventsInContext.some(
          (event) => command.order !== undefined && event.order !== undefined && command.order < event.order,
        ),
      );
      const structural =
        (kinds.has("actor") ? 0.2 : 0) +
        (kinds.has("command") ? 0.25 : 0) +
        (kinds.has("aggregate") ? 0.2 : 0) +
        (kinds.has("domainEvent") ? 0.25 : 0) +
        (kinds.has("policy") ? 0.1 : 0);
      return structural * (hasCausalOrder ? 1 : 0.8);
    }),
  );
  const businessRules = ratio(
    policies + aggregates + contexts.reduce((n, context) => n + context.businessDecisions.length, 0),
    Math.max(contexts.length * 3, 1),
  );
  // 4 defined terms per context, not 2: a context's language isn't "clear" off a single pair.
  const languageClarity = average(
    contexts.map((context) =>
      ratio(
        context.ubiquitousLanguage.filter((term) => term.term.trim() && term.definition.trim()).length,
        4,
      ),
    ),
  );
  const assignedStickies = stickies.filter((sticky) =>
    contexts.some((context) => context.id === sticky.boundedContextId),
  ).length;
  const boundaryDefinition =
    ratio(assignedStickies, stickies.length) * 0.5 +
    average(contexts.map((context) => (context.purpose.trim() ? 1 : 0))) * 0.25 +
    average(
      contexts.map((context, index) =>
        context.stickyIds.length > 0 || contextStickies[index].length > 0 ? 1 : 0,
      ),
    ) * 0.25;
  const failurePattern = /reject|declin|fail|cancel|expire|timeout|recover|compensat|invalid|error/i;
  // Top-level hotspots aren't owned by a context, so they lift every context a little rather
  // than standing in for one. Each context still needs its own signal to score full marks.
  const looseFailureSignals = state.canvas.hotspots.filter((hotspot) =>
    failurePattern.test(hotspot.text),
  ).length;
  // Averaged per context, not summed canvas-wide: otherwise one context full of cancellation
  // paths covers for every other context that models only the happy path.
  const failureCoverage =
    contexts.length === 0
      ? ratio(
          looseFailureSignals + stickies.filter((sticky) => failurePattern.test(sticky.text)).length,
          2,
        )
      : average(
          contexts.map((context, index) =>
            ratio(
              contextStickies[index].filter((sticky) => failurePattern.test(sticky.text)).length +
                context.openQuestions.filter((item) => failurePattern.test(item)).length +
                context.assumptions.filter((item) => failurePattern.test(item)).length +
                Math.min(looseFailureSignals, 1),
              2,
            ),
          ),
        );
  const decisionSupport = average(
    contextStickies.map((items) => {
      const kinds = new Set(items.map((item) => item.kind));
      return (kinds.has("actor") ? 0.5 : 0) + (kinds.has("readModel") ? 0.5 : 0);
    }),
  );
  const evidenceCoverage = ratio(
    stickies.filter((sticky) => sticky.sourceChunkIds.length > 0).length,
    stickies.length,
  );
  const explicitUncertainty =
    hotspots + contexts.reduce((n, context) => n + context.assumptions.length + context.openQuestions.length, 0) > 0
      ? 1
      : 0;
  const evidenceAndUncertainty = evidenceCoverage * 0.75 + explicitUncertainty * 0.25;

  const rawScore =
    behavioralFlow * 2.5 +
    businessRules * 1.5 +
    languageClarity * 1.5 +
    boundaryDefinition * 1.5 +
    failureCoverage +
    decisionSupport +
    evidenceAndUncertainty;
  const score = Math.max(1, Math.min(10, Math.round(rawScore)));
  const maturity = score <= 3 ? "Emerging" : score <= 7 ? "Developing" : "Coherent";

  const represented = [
    events > 0 ? "events" : null,
    commands > 0 ? "commands" : null,
    actors > 0 ? "actors" : null,
    policies > 0 ? "policies" : null,
    aggregates > 0 ? "aggregates" : null,
    readModels > 0 ? "read models" : null,
    externalSystems > 0 ? "external systems" : null,
    contexts.length > 0 ? "bounded contexts" : null,
  ].filter((value): value is string => value !== null);
  const missing = [
    contexts.length === 0
      ? "define bounded contexts with clear business ownership"
      : boundaryDefinition < 0.75
        ? "assign every behavior to an explicit bounded context"
        : null,
    behavioralFlow < 0.75
      ? "connect actor → command → aggregate → event flows"
      : null,
    businessRules < 0.65
      ? "make policies, business decisions, and protected invariants explicit"
      : null,
    languageClarity < 0.65
      ? "define the ubiquitous language used inside each context"
      : null,
    failureCoverage < 0.6
      ? "model rejection, cancellation, recovery, and terminal paths"
      : null,
    decisionSupport < 0.75
      ? "show the read models actors need before making decisions"
      : null,
    evidenceAndUncertainty < 0.7
      ? "trace model elements to evidence and keep uncertainty visible"
      : null,
    contexts.length > 1 &&
    contexts.every(
      (context) => context.inboundCommunication.length + context.outboundCommunication.length === 0,
    )
      ? "name cross-context messages and counterparties"
      : null,
  ].filter((value): value is string => value !== null);

  return {
    score,
    maturity,
    summary: "Live coherence estimate shown while the Coach prepares its deeper model review.",
    scoreRationale:
      "This provisional score weighs connected behavior, rules, language, boundaries, exceptions, decision support, and evidence; the Coach will replace it with a semantic review.",
    feedback: [
      {
        tone: "positive",
        title: "The model is taking shape",
        summary: represented.length
          ? `The Canvas already represents ${represented.slice(0, 4).join(", ")}.`
          : "The Canvas has enough content to begin a structured review.",
        detail: `${stickies.length} canvas cards across ${contexts.length} bounded context${contexts.length === 1 ? "" : "s"} are available for review. The deeper Coach review will validate causal relationships and business meaning.`,
      },
      {
        tone: "constructive",
        title: missing.length ? "Close the highest-impact coherence gaps" : "Validate specification readiness",
        summary: missing.length
          ? `Next, ${missing.slice(0, 2).join("; then ")}.`
          : "Next, challenge the model with concrete exceptions and cross-context scenarios.",
        detail: missing.length
          ? `Missing or weak areas: ${missing.join("; ")}. Use these as workshop questions rather than silently inventing domain decisions.`
          : "The visible model passes the structural coherence checks; confirm the business rules, language, evidence, and edge cases with domain experts before treating it as specification-ready.",
      },
    ],
  };
}

/**
 * Interactive, user-triggered chat agent. Each question runs a fresh query() over the
 * current session context (read-only — the Coach never writes the Canvas) and streams the
 * reply to the UI as coach.delta events, finishing with coach.done. Proactive assessments
 * continue on a timer even while synthesis is busy; a deterministic provisional review keeps
 * the UI useful while the deeper model call is queued or retrying.
 */
export class CoachAgent {
  private systemPrompt = "";
  private assessmentSystemPrompt = "";
  private unsubscribe: (() => void) | null = null;
  private assessmentTimer: ReturnType<typeof setTimeout> | null = null;
  private assessmentInterval: ReturnType<typeof setInterval> | null = null;
  private assessmentRunning = false;
  /** Set while the spec pipeline owns the session: no new proactive reviews are armed. */
  private assessmentsSuspended = false;
  private lastSuccessfulRevision = 0;
  private lastSuccessfulTranscriptSeq = 0;
  private lastProvisionalRevision = 0;
  /** When the last deep review FINISHED — the anchor for the minimum-interval floor. */
  private lastAssessmentAt = 0;

  constructor(
    private readonly memory: SessionMemory,
    private readonly bus: EventBus,
  ) {}

  async init(): Promise<void> {
    const [steering, method] = await Promise.all([
      loadSteering([...AGENTS.coach.steering]),
      loadSteering(ASSESSMENT_STEERING),
    ]);
    this.systemPrompt = `${ROLE}\n\n${steering}`;
    this.assessmentSystemPrompt = `${this.systemPrompt}\n\n---\n\n${method}`;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((event: ServerEvent) => {
      if (event.type === "agent.status" && event.agent === "synthesizer") {
        if (event.state === "done" || event.state === "failed") this.scheduleAssessment();
      } else if (event.type === "canvas.updated") {
        // Keep visible feedback current even while live synthesis is still running.
        this.ensureProvisionalAssessment();
        this.scheduleAssessment();
      } else if (event.type === "transcript.chunk") {
        // New evidence can expose missing behavior even before the Synthesizer changes Canvas.
        this.scheduleAssessment();
      }
    });
    this.ensureProvisionalAssessment();
    this.scheduleAssessment();
    this.assessmentInterval = setInterval(() => {
      this.ensureProvisionalAssessment();
      this.scheduleAssessment(0);
    }, COACH_CONFIG.assessmentMinIntervalMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelScheduledAssessment();
    if (this.assessmentInterval) clearInterval(this.assessmentInterval);
    this.assessmentInterval = null;
  }

  /**
   * Stop starting new proactive reviews. An in-flight review finishes on its own — this only
   * prevents arming — and the interactive `ask()` path is untouched, so facilitator chat and
   * hint engagement keep working. Used when the spec pipeline takes over the session.
   */
  suspendAssessments(): void {
    this.assessmentsSuspended = true;
    this.cancelScheduledAssessment();
  }

  /** Undo suspendAssessments when the session becomes live again (e.g. a replay starts). */
  resumeAssessments(): void {
    this.assessmentsSuspended = false;
  }

  /** Forget the previous session's review watermarks so a reset session is assessed afresh. */
  reset(): void {
    this.assessmentsSuspended = false;
    this.cancelScheduledAssessment();
    this.lastSuccessfulRevision = 0;
    this.lastSuccessfulTranscriptSeq = 0;
    this.lastProvisionalRevision = 0;
    // A fresh session must not inherit the previous one's floor, or its first deep review would
    // be held back by up to a minute of unrelated history. (index.ts calls reset() without
    // stop()/start(), so these fields survive a session reset.)
    this.lastAssessmentAt = 0;
  }

  /** Answer a facilitator question, streaming the reply over the event bus. */
  async ask(userText: string): Promise<void> {
    const state = this.memory.getState();
    const messageId = `coach-${randomUUID()}`;

    const prompt = [
      sessionContext(state),
      "",
      "RECENT CONVERSATION:",
      recentChat(state.coachChat),
      "",
      `FACILITATOR'S QUESTION:\n${userText}`,
    ].join("\n");

    let streamed = "";
    const result = await withSpan(
      "coach.ask",
      { sessionId: state.id, metadata: { messageId }, input: userText },
      () =>
        runAgent({
          agent: "coach",
          label: "coach",
          systemPrompt: this.systemPrompt,
          prompt,
          timeoutMs: 90_000,
          onText: (delta) => {
            streamed += delta;
            this.bus.emit({ type: "coach.delta", messageId, text: delta });
          },
          options: {
            model: AGENTS.coach.model,
            effort: "medium",
            maxTurns: 4,
            maxBudgetUsd: 0.5,
          },
        }),
    );

    // A run that produced no text has nothing to say — stay silent rather than posting an
    // empty bubble. Covers two cases: a failed run (which ends with agent.status "failed", and
    // the client shows an inline error we must not paint over), and a run dropped from the
    // scheduler queue by a session reset, which resolves as a NON-error empty result and would
    // otherwise land "(no response)" in the brand-new session's chat.
    if (!streamed && !result.text) return;

    const text = streamed || result.text || "(no response)";
    const message: ChatMessage = {
      id: messageId,
      role: "coach",
      text,
      ts: new Date().toISOString(),
    };
    this.memory.appendCoachMessage(message);
    this.bus.emit({ type: "coach.done", message });
  }

  private cancelScheduledAssessment(): void {
    if (!this.assessmentTimer) return;
    clearTimeout(this.assessmentTimer);
    this.assessmentTimer = null;
  }

  private ensureProvisionalAssessment(): void {
    const state = this.memory.getState();
    const storedProvisionalRevision = state.coachChat.reduce(
      (latest, message) =>
        message.id.startsWith(PROVISIONAL_ID_PREFIX) && message.canvasRevision !== undefined
          ? Math.max(latest, message.canvasRevision)
          : latest,
      0,
    );
    this.lastProvisionalRevision = Math.max(
      this.lastProvisionalRevision,
      storedProvisionalRevision,
    );
    if (
      state.canvas.stickies.length === 0 ||
      state.revision <= this.lastProvisionalRevision
    ) {
      return;
    }

    const assessment = provisionalAssessment(state);
    const message: ChatMessage = {
      id: PROVISIONAL_ID,
      role: "coach",
      kind: "assessment",
      canvasRevision: state.revision,
      transcriptSeq: state.transcript.at(-1)?.seq ?? 0,
      text: assessment.summary,
      assessment,
      ts: new Date().toISOString(),
    };
    this.lastProvisionalRevision = state.revision;
    this.memory.appendCoachMessage(message);
    this.bus.emit({ type: "coach.done", message });
  }

  /**
   * Arms a trailing assessment. Deliberately arm-once rather than a resetting debounce: the
   * replayer emits a chunk every second and each chunk triggers this, so re-arming on every
   * trigger would push the deadline out forever and starve the deep review (the same reason
   * HintAgent.onActivity arms once). An explicit delayMs — the interval's 0 — re-arms so a
   * periodic review can still preempt a pending timer. assessCurrentCanvas re-reads state
   * when it fires, so riding an already-armed timer never assesses stale input.
   *
   * Every arming path — the event triggers, the interval's explicit 0, and the re-arm in
   * assessCurrentCanvas's finally — is floored by assessmentDelay. This is the only setTimeout
   * in the class, which is what makes that guarantee hold by construction; keep it that way.
   */
  private scheduleAssessment(delayMs?: number): void {
    // Owning the only setTimeout in the class is what lets this single check cover every arming
    // path: the bus triggers, the periodic interval's explicit 0, and the re-arm in
    // assessCurrentCanvas's finally.
    if (this.assessmentsSuspended) return;
    if (delayMs === undefined && this.assessmentTimer) return;
    this.cancelScheduledAssessment();
    const state = this.memory.getState();
    const completedAssessments = state.coachChat.filter(
      (message) =>
        message.kind === "assessment" &&
        !message.id.startsWith(PROVISIONAL_ID_PREFIX) &&
        message.assessment !== undefined,
    );
    const storedAssessmentRevision = completedAssessments.reduce(
      (latest, message) => Math.max(latest, message.canvasRevision ?? 0),
      0,
    );
    const storedAssessmentTranscriptSeq = completedAssessments.reduce(
      (latest, message) => Math.max(latest, message.transcriptSeq ?? 0),
      0,
    );
    this.lastSuccessfulRevision = Math.max(
      this.lastSuccessfulRevision,
      storedAssessmentRevision,
    );
    this.lastSuccessfulTranscriptSeq = Math.max(
      this.lastSuccessfulTranscriptSeq,
      storedAssessmentTranscriptSeq,
    );
    const latestTranscriptSeq = state.transcript.at(-1)?.seq ?? 0;
    if (
      this.assessmentRunning ||
      state.canvas.stickies.length === 0 ||
      (state.revision <= this.lastSuccessfulRevision &&
        latestTranscriptSeq <= this.lastSuccessfulTranscriptSeq)
    ) {
      return;
    }
    this.assessmentTimer = setTimeout(
      () => {
        this.assessmentTimer = null;
        void this.assessCurrentCanvas();
      },
      assessmentDelay(
        delayMs ?? COACH_CONFIG.assessmentDebounceMs,
        this.lastAssessmentAt,
        Date.now(),
      ),
    );
  }

  private async assessCurrentCanvas(): Promise<void> {
    const state = this.memory.getState();
    const canvasRevision = state.revision;
    const transcriptSeq = state.transcript.at(-1)?.seq ?? 0;
    if (
      this.assessmentRunning ||
      state.canvas.stickies.length === 0 ||
      (canvasRevision <= this.lastSuccessfulRevision &&
        transcriptSeq <= this.lastSuccessfulTranscriptSeq)
    ) {
      return;
    }

    this.assessmentRunning = true;
    const messageId = `assessment-${canvasRevision}-${randomUUID()}`;
    const prompt = [
      "Proactively review the current Canvas with the Assess Domain Model method.",
      "Follow the method's JSON response contract exactly and return only the JSON object.",
      "Score coherence, not sticky volume. Always identify the highest-impact missing area",
      "and turn it into a concrete next workshop question or action.",
      "",
      assessmentContext(state),
    ].join("\n");

    try {
      const result = await withSpan(
        "coach.assess",
        {
          sessionId: state.id,
          metadata: { messageId, canvasRevision: String(canvasRevision) },
        },
        () =>
          runAgent({
            // Not "coach": this is background work that must yield to synthesis, and the client
            // turns a failed `coach` run into an inline chat error (useSessionStream.ts) — a
            // proactive review timing out must not post an error into the facilitator's chat.
            agent: "assessment",
            label: "coach:assessment",
            systemPrompt: this.assessmentSystemPrompt,
            prompt,
            timeoutMs: 120_000,
            options: {
              model: AGENTS.coach.model,
              effort: "medium",
              maxTurns: 5,
              maxBudgetUsd: 0.75,
            },
          }),
      );

      const text = result.text.trim();
      const assessment = parseModelAssessment(text);
      if (result.isError || !assessment) {
        console.error(
          result.isError
            ? "[coach] proactive assessment errored; retaining provisional feedback and retrying"
            : "[coach] proactive assessment returned invalid structured data; retaining provisional feedback and retrying",
        );
        return;
      }
      this.lastSuccessfulRevision = canvasRevision;
      this.lastSuccessfulTranscriptSeq = transcriptSeq;
      const message: ChatMessage = {
        id: messageId,
        role: "coach",
        kind: "assessment",
        canvasRevision,
        transcriptSeq,
        text: assessment.summary,
        assessment,
        ts: new Date().toISOString(),
      };
      this.memory.appendCoachMessage(message);
      this.bus.emit({ type: "coach.done", message });
    } catch (err) {
      console.error(
        "[coach] proactive assessment failed; retaining provisional feedback and retrying:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.assessmentRunning = false;
      // Stamped on completion, not on start (HintAgent stamps at start, but its pass timeout
      // equals its minimum interval so the distinction barely matters there). A review can run
      // for up to 120s behind an unbounded scheduler queue, so a start stamp would already be
      // expired by the time the run ends and the re-arm below would chain a second review with
      // only the debounce between them. This also floors the retry after an invalid-JSON reply,
      // which does not advance the watermarks and would otherwise retry on the next chunk.
      // Must precede the re-arm below so scheduleAssessment sees the fresh stamp.
      this.lastAssessmentAt = Date.now();
      // A newer Canvas revision should be reviewed promptly after a successful older review.
      // Failed reviews are retried by the interval to avoid a tight error loop.
      const latestTranscriptSeq = this.memory.getState().transcript.at(-1)?.seq ?? 0;
      if (
        this.memory.revision > this.lastSuccessfulRevision ||
        latestTranscriptSeq > this.lastSuccessfulTranscriptSeq
      ) {
        this.ensureProvisionalAssessment();
        if (
          this.lastSuccessfulRevision === canvasRevision &&
          this.lastSuccessfulTranscriptSeq === transcriptSeq
        ) {
          this.scheduleAssessment();
        }
      }
    }
  }
}

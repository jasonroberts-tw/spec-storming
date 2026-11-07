import type { PipelineStage, PipelineState, SpecArtifact } from "@specstorming/shared";
import { emptyPipeline } from "@specstorming/shared";
import type { EventBus } from "../bus/EventBus.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";
import { withSpan } from "../observability/tracing.ts";
import { serializeArtifact } from "./artifact.ts";
import { runBoundaryAnalyzer } from "./BoundaryAnalyzer.ts";
import { runSolutionArchitect } from "./SolutionArchitect.ts";
import { runNegotiation } from "./negotiation.ts";

/** The three stage entry points, injectable so tests can drive run() without the Agent SDK. */
export interface PipelineSteps {
  boundaryAnalyzer: typeof runBoundaryAnalyzer;
  solutionArchitect: typeof runSolutionArchitect;
  negotiation: typeof runNegotiation;
}

const DEFAULT_STEPS: PipelineSteps = {
  boundaryAnalyzer: runBoundaryAnalyzer,
  solutionArchitect: runSolutionArchitect,
  negotiation: runNegotiation,
};

/** Thrown at a stage boundary when reset() abandoned the run; swallowed by run(). */
class PipelineAborted extends Error {
  constructor() {
    super("pipeline run abandoned");
    this.name = "PipelineAborted";
  }
}

/**
 * Runs the Phase 2 → Phase 3 spec pipeline on the finished session artifact and streams
 * progress/results over the event bus. Every step is sequential: concurrent Agent SDK query()
 * calls interfere (one returns empty), so Phase 2 runs the Boundary Analyzer then the Solution
 * Architect, and Phase 3 (System Architect ↔ Business/Product negotiation) runs after both.
 */
export class PipelineRunner {
  private state: PipelineState = emptyPipeline();
  private running = false;
  /** Bumped by reset(); a run whose id no longer matches has been abandoned and stops writing. */
  private runId = 0;
  /** Cancellation for the in-flight run, so reset() can actually stop it. */
  private abort: AbortController | null = null;
  private readonly steps: PipelineSteps;

  constructor(
    private readonly memory: SessionMemory,
    private readonly bus: EventBus,
    steps: Partial<PipelineSteps> = {},
  ) {
    this.steps = { ...DEFAULT_STEPS, ...steps };
  }

  getState(): Readonly<PipelineState> {
    return this.state;
  }

  /** True while a run is in flight, so the route can reject a concurrent request truthfully. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Drop the produced specs and go back to idle (session reset). Without this the artifacts
   * outlive the session that produced them: /api/stream replays getState().artifacts to every
   * newly connected client, so the previous session's specs reappear on a browser refresh.
   *
   * A run in flight is genuinely cancelled: the abort stops the executing SDK query and every
   * step still queued behind it, and run() bails at the next stage boundary. That matters
   * beyond wasted spend — an abandoned run keeps enqueuing its remaining steps as `pipeline`
   * jobs, and the AgentScheduler serializes *jobs*, not runs, so a new run's steps interleave
   * one-for-one with the orphan's. That is what makes Phase 3 of one run execute before Phase 2
   * of another. The runId bump remains as the belt-and-braces guard on writes, and `running` is
   * released so the new session can start immediately.
   */
  reset(): void {
    this.runId += 1;
    this.abort?.abort();
    this.abort = null;
    this.running = false;
    this.state = emptyPipeline();
    this.bus.emit({ type: "pipeline.status", stage: "idle" });
  }

  private setStage(runId: number, stage: PipelineStage, detail?: string): void {
    if (runId !== this.runId) return;
    this.state.stage = stage;
    this.state.detail = detail;
    this.bus.emit({ type: "pipeline.status", stage, detail });
  }

  private addArtifact(runId: number, artifact: SpecArtifact): void {
    if (runId !== this.runId) return;
    this.state.artifacts.push(artifact);
    this.bus.emit({ type: "spec.produced", artifact });
  }

  /** Kick off the pipeline. Returns false (without starting) when a run is already in flight. */
  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const runId = this.runId;
    const ac = new AbortController();
    this.abort = ac;
    this.state.artifacts = [];

    const artifact = serializeArtifact(this.memory.getState());

    /** Stop at a stage boundary rather than queueing the next step's agent run. */
    const checkpoint = (): void => {
      if (ac.signal.aborted) throw new PipelineAborted();
    };

    try {
      // One Langfuse trace for the whole pipeline; the per-agent generations below nest under it.
      await withSpan("spec.pipeline", { sessionId: this.memory.getState().id }, async () => {
        // Phase 2: two workflows. Run sequentially — concurrent Agent SDK query() calls
        // interfere (one returns empty), so we trade a little wall-clock for reliability.
        this.setStage(runId, "boundary-analysis", "Boundary Analyzer: per-context specs…");
        const bcSpec = await this.steps.boundaryAnalyzer(artifact, ac.signal);
        checkpoint();
        this.addArtifact(runId, bcSpec);

        this.setStage(runId, "architecture", "Solution Architect: NFR / architecture spec…");
        const archSpec = await this.steps.solutionArchitect(artifact, ac.signal);
        checkpoint();
        this.addArtifact(runId, archSpec);

        // Phase 3: adversarial negotiation → System Specification.
        this.setStage(runId, "negotiation", "System Architect ↔ Business/Product negotiating…");
        const systemSpec = await this.steps.negotiation(
          { boundedContextSpec: bcSpec.markdown, architectureSpec: archSpec.markdown },
          ac.signal,
        );
        checkpoint();
        this.addArtifact(runId, systemSpec);
      });

      this.setStage(runId, "done");
      return true;
    } catch (err) {
      // A cancelled run is a normal outcome of Start Over, not a failure to report. Its own
      // steps also fail loudly once aborted (requireAgentText on an empty cancelled result),
      // so treat any error from an abandoned run the same way.
      if (err instanceof PipelineAborted || ac.signal.aborted) {
        console.error("[pipeline] run cancelled (session reset)");
        return false;
      }
      console.error("[pipeline] failed:", err);
      this.setStage(runId, "error", err instanceof Error ? err.message : "pipeline failed");
      return false;
    } finally {
      // Only if we're still the current run — an orphan must not clear a newer run's flag or
      // tear down the controller a newer run installed.
      if (runId === this.runId) {
        this.running = false;
        if (this.abort === ac) this.abort = null;
      }
    }
  }
}

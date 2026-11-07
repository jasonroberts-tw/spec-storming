/**
 * Priority-aware serialization of agent runs. Concurrent Agent SDK query() calls interfere
 * (one can return empty), so exactly one job executes at a time; pending jobs are dequeued
 * synthesizer-first, then the interactive coach, pipeline, the proactive assessment, and finally
 * hints — FIFO within a priority class. See AGENT_PRIORITY for why that order.
 * Lifecycle transitions (queued/running/done/failed) are reported via onLifecycle so the
 * server can broadcast truthful agent.status events.
 */

import { AsyncResource } from "node:async_hooks";

export type AgentIdentity = "synthesizer" | "coach" | "pipeline" | "assessment" | "hints";

/**
 * Lower runs first; FIFO within a class. Synthesis outranks everything — the canvas is what every
 * other agent reads, so starving it degrades all of them. The interactive coach is next because a
 * facilitator is waiting on the reply. Pipeline assumes a completed session (nothing live is
 * running), and sits below the coach so that if that assumption ever breaks the cost is a delayed
 * spec rather than a person waiting behind six sequential 150s calls. The Coach's proactive
 * assessment and the hint pass are background work and yield to all of it.
 */
export const AGENT_PRIORITY: Record<AgentIdentity, number> = {
  synthesizer: 0,
  coach: 1,
  pipeline: 2,
  assessment: 3,
  hints: 4,
};

export type AgentRunState = "queued" | "running" | "done" | "failed";

export interface AgentLifecycleEvent {
  agent: AgentIdentity;
  state: AgentRunState;
  detail?: string;
}

export interface ScheduleOptions {
  /** A pending (not yet running) job with the same key is replaced by this one; the replaced
   * job resolves to undefined. Used so at most one hint pass ever waits in the queue. */
  replaceKey?: string;
  /** Classify a resolved value as a soft failure (e.g. runAgent's isError results). */
  outcome?: (value: unknown) => { failed: boolean; detail?: string };
}

interface Job<T> {
  agent: AgentIdentity;
  priority: number;
  seq: number;
  run: () => Promise<T>;
  resolve: (value: T | undefined) => void;
  reject: (err: unknown) => void;
  replaceKey?: string;
  outcome?: ScheduleOptions["outcome"];
}

export class AgentScheduler {
  private queue: Job<unknown>[] = [];
  private activeJob: Job<unknown> | null = null;
  private seqCounter = 0;
  private latest = new Map<AgentIdentity, AgentLifecycleEvent>();

  /** Wired by the server bootstrap to broadcast agent.status events. */
  onLifecycle?: (event: AgentLifecycleEvent) => void;

  /** Serialize a job. Resolves with the job's value, or undefined if replaced while queued. */
  schedule<T>(agent: AgentIdentity, run: () => Promise<T>, opts: ScheduleOptions = {}): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      if (opts.replaceKey) {
        const idx = this.queue.findIndex((j) => j.replaceKey === opts.replaceKey);
        if (idx >= 0) this.queue.splice(idx, 1)[0].resolve(undefined);
      }
      this.seqCounter += 1;
      const job: Job<T> = {
        agent,
        priority: AGENT_PRIORITY[agent],
        seq: this.seqCounter,
        // Bind to the caller's async context so tracing spans still nest correctly when the
        // job executes later from the scheduler's pump loop.
        run: AsyncResource.bind(run),
        resolve,
        reject,
        replaceKey: opts.replaceKey,
        outcome: opts.outcome,
      };
      this.queue.push(job as Job<unknown>);
      this.emit({ agent, state: "queued" });
      this.pump();
    });
  }

  /** True while a job is executing or waiting. */
  busy(): boolean {
    return this.activeJob !== null || this.queue.length > 0;
  }

  /** Most recent lifecycle event per agent, for SSE catch-up on connect. */
  latestStatuses(): AgentLifecycleEvent[] {
    return [...this.latest.values()];
  }

  /**
   * Abandon queued work and forget per-agent status (session reset).
   *
   * Both halves matter. A job queued against the previous session still carries a prompt built
   * from the old canvas, and its MCP tools write into SessionMemory — which by the time it runs
   * is the NEW session, so a stale hint pass would post hints about a session that no longer
   * exists. And `latest` is replayed to every new SSE client, so a chip from the old session
   * ("synthesizing…", "hint pass failed") would reappear on refresh.
   *
   * Dequeued jobs resolve to `undefined` — the same contract as a replaceKey replacement, which
   * runAgent already maps to an empty non-error result — so no caller's promise hangs. A job
   * that is already executing is left alone: there is no cancellation seam through the
   * scheduler, and its own agent's abort() is what stops the expensive work.
   */
  reset(): void {
    const dropped = this.queue;
    this.queue = [];
    this.latest.clear();
    for (const job of dropped) job.resolve(undefined);
  }

  private emit(event: AgentLifecycleEvent): void {
    this.latest.set(event.agent, event);
    this.onLifecycle?.(event);
  }

  private pump(): void {
    if (this.activeJob || this.queue.length === 0) return;
    let next = this.queue[0];
    for (const job of this.queue) {
      if (job.priority < next.priority || (job.priority === next.priority && job.seq < next.seq)) {
        next = job;
      }
    }
    this.queue.splice(this.queue.indexOf(next), 1);
    this.activeJob = next;
    this.emit({ agent: next.agent, state: "running" });
    void this.execute(next);
  }

  private async execute(job: Job<unknown>): Promise<void> {
    try {
      const value = await job.run();
      const verdict = job.outcome?.(value);
      // Clear before resolving so callers awaiting the result observe an idle scheduler.
      this.activeJob = null;
      this.emit(
        verdict?.failed
          ? { agent: job.agent, state: "failed", detail: verdict.detail }
          : { agent: job.agent, state: "done" },
      );
      job.resolve(value);
    } catch (err) {
      this.activeJob = null;
      this.emit({
        agent: job.agent,
        state: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      job.reject(err);
    }
    this.pump();
  }
}

/** The process-wide scheduler every agent run goes through. */
export const agentScheduler = new AgentScheduler();

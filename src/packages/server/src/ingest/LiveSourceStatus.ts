import type { LiveSourceState } from "@specstorming/shared";
import type { EventBus } from "../bus/EventBus.ts";

/**
 * Tracks the live transcript source (Zoom RTMS) connection state and broadcasts
 * transitions as `live.status`. Holds the latest value so the SSE catch-up burst
 * can replay it to newly connected clients.
 */
export class LiveSourceStatus {
  private current: { state: LiveSourceState; detail?: string } = { state: "off" };

  constructor(private readonly bus: EventBus) {}

  get state(): LiveSourceState {
    return this.current.state;
  }

  get connected(): boolean {
    return this.current.state === "connected";
  }

  latest(): { state: LiveSourceState; detail?: string } {
    return this.current;
  }

  set(state: LiveSourceState, detail?: string): void {
    if (this.current.state === state && this.current.detail === detail) return;
    this.current = { state, detail };
    this.bus.emit({ type: "live.status", state, detail });
  }
}

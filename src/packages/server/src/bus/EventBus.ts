import { EventEmitter } from "node:events";
import type { ServerEvent } from "@specstorming/shared";

/**
 * A tiny typed pub/sub for server-side events. Everything that wants to push to
 * connected SSE clients emits a ServerEvent here; the SSE handler subscribes.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients + internal listeners; lift the default cap.
    this.emitter.setMaxListeners(100);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit("event", event);
  }

  /** Subscribe to all server events. Returns an unsubscribe function. */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}

import type { LiveSourceState } from "@specstorming/shared";
import { extractRtmsPayload, extractRtmsStreamId } from "./protocol.ts";
import type { ZoomRtmsClient } from "./ZoomRtmsClient.ts";

export interface RtmsDispatchDeps {
  enabled: boolean;
  replayRunning: () => boolean;
  client: ZoomRtmsClient;
  status: (state: LiveSourceState, detail?: string) => void;
  log: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Decide what a verified `meeting.rtms_started` / `meeting.rtms_stopped`
 * webhook does. Kept apart from the Fastify route so the exclusion rules are
 * unit-testable without HTTP.
 */
export function handleRtmsEvent(eventName: string, event: unknown, deps: RtmsDispatchDeps): void {
  if (eventName === "meeting.rtms_started") {
    if (!deps.enabled) {
      deps.log.info("rtms_started ignored: ZOOM_RTMS_ENABLED is off");
      return;
    }
    if (deps.replayRunning()) {
      deps.log.warn("rtms_started refused: transcript replay is running");
      deps.status("off", "live source refused: replay is active");
      return;
    }
    const stream = extractRtmsPayload(event);
    if (!stream) {
      deps.log.error("rtms_started payload missing meeting_uuid/rtms_stream_id/server_urls");
      return;
    }
    deps.client.start(stream);
    return;
  }

  if (eventName === "meeting.rtms_stopped") {
    const streamId = extractRtmsStreamId(event);
    if (deps.client.active && (streamId === null || streamId === deps.client.streamId)) {
      deps.client.stop("meeting ended");
    }
  }
}

import { createHmac } from "node:crypto";

/**
 * Zoom RTMS protocol constants and payload shapes, verified against
 * developers.zoom.us/docs/rtms/data-types/, docs/api/rtms/events, and Zoom's
 * official sample repos (rtms-samples, rtms-quickstart-js, zoom-plugin).
 *
 * Known ambiguities across Zoom's own sources (verify empirically at rehearsal):
 *  - Webhook fields may arrive flat under `payload.*` (API reference) or nested
 *    under `payload.object.*` (zoom-plugin skill doc) — extractRtmsPayload handles both.
 *  - TRANSCRIPT media_type bit: 8 per the docs page + zoom-plugin (used here);
 *    one stale rtms-samples table claims 16. A wrong value fails the data
 *    handshake with status 7/14, which we log.
 *  - Whether transcript messages are always finalized utterances is undocumented;
 *    the client's duplicate suppression tolerates re-delivery either way.
 */

export const MSG_TYPE = {
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  CLIENT_READY_ACK: 7,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_TRANSCRIPT: 17,
} as const;

export const STATUS_OK = 0;
/** media_type bitmask: transcript stream only. */
export const MEDIA_TYPE_TRANSCRIPT = 8;
/** media_params.transcript.content_type: plain text. */
export const CONTENT_TYPE_TEXT = 5;

export interface RtmsStreamInfo {
  meetingUuid: string;
  streamId: string;
  serverUrl: string;
}

/**
 * Pull meeting_uuid / rtms_stream_id / server_urls out of a webhook event,
 * accepting both the flat (`payload.*`) and nested (`payload.object.*`) shapes
 * Zoom's docs disagree on. Returns null if required fields are missing
 * (server_urls is absent on `meeting.rtms_stopped`, so callers of stopped
 * events should read ids from the same object this function picks).
 */
export function extractRtmsPayload(event: unknown): RtmsStreamInfo | null {
  const payload = (event as { payload?: Record<string, unknown> })?.payload;
  if (!payload) return null;
  const obj = (
    typeof payload.object === "object" && payload.object !== null ? payload.object : payload
  ) as Record<string, unknown>;
  const meetingUuid = obj.meeting_uuid;
  const streamId = obj.rtms_stream_id;
  const serverUrl = obj.server_urls;
  if (typeof meetingUuid !== "string" || typeof streamId !== "string" || typeof serverUrl !== "string") {
    return null;
  }
  return { meetingUuid, streamId, serverUrl };
}

/** Ids of a stopped stream (no server_urls on rtms_stopped events). */
export function extractRtmsStreamId(event: unknown): string | null {
  const payload = (event as { payload?: Record<string, unknown> })?.payload;
  if (!payload) return null;
  const obj = (
    typeof payload.object === "object" && payload.object !== null ? payload.object : payload
  ) as Record<string, unknown>;
  return typeof obj.rtms_stream_id === "string" ? obj.rtms_stream_id : null;
}

/**
 * Whether a signaling/media URL is a legitimate Zoom RTMS endpoint: `wss://`
 * over a `*.zoom.us` host. Guards against SSRF — `server_urls` (webhook) and the
 * media URL (signaling response) are attacker-influenceable, so a forged or
 * tampered value must not steer the client at loopback/internal hosts.
 */
export function isAllowedRtmsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "wss:") return false;
    const host = u.hostname.toLowerCase();
    return host === "zoom.us" || host.endsWith(".zoom.us");
  } catch {
    return false;
  }
}

/**
 * Handshake signature, used for both the signaling and data handshakes:
 * HMAC-SHA256 hex over "{clientId},{meetingUuid},{streamId}" keyed with the
 * OAuth client secret.
 */
export function handshakeSignature(
  clientId: string,
  clientSecret: string,
  meetingUuid: string,
  streamId: string,
): string {
  return createHmac("sha256", clientSecret)
    .update(`${clientId},${meetingUuid},${streamId}`)
    .digest("hex");
}

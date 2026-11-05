import WebSocket from "ws";
import type { LiveSourceState } from "@specstorming/shared";
import {
  CONTENT_TYPE_TEXT,
  MEDIA_TYPE_TRANSCRIPT,
  MSG_TYPE,
  STATUS_OK,
  handshakeSignature,
  isAllowedRtmsUrl,
  type RtmsStreamInfo,
} from "./protocol.ts";

export interface RtmsClientDeps {
  credentials: { clientId: string; clientSecret: string };
  /** Where finalized transcript utterances land (wired to SessionMemory.appendChunk). */
  sink: (chunk: { speaker: string; text: string; ts?: string }) => void;
  /** Live-source state reporting (wired to LiveSourceStatus.set). */
  status: (state: LiveSourceState, detail?: string) => void;
  /** Test/demo escape hatch: skip the wss://*.zoom.us allowlist for stub servers. */
  allowInsecureUrls?: boolean;
  log?: Pick<Console, "info" | "warn" | "error">;
}

const MAX_RECONNECT_ATTEMPTS = 6;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Client for one Zoom RTMS transcript stream: signaling handshake → media
 * handshake (transcript only) → CLIENT_READY_ACK on the signaling socket →
 * transcript messages flow. Answers keep-alives on both sockets; reconnects
 * with bounded backoff while the meeting is live; tears down on rtms_stopped.
 */
export class ZoomRtmsClient {
  private stream: RtmsStreamInfo | null = null;
  private signalingWs: WebSocket | null = null;
  private mediaWs: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private handshakeSequence = 0;
  /** Last ingested transcript message per speaker, for post-reconnect dedupe. */
  private lastBySpeaker = new Map<string, { ts: number; text: string }>();

  constructor(private readonly deps: RtmsClientDeps) {}

  get active(): boolean {
    return this.stream !== null;
  }

  get streamId(): string | null {
    return this.stream?.streamId ?? null;
  }

  /** Begin streaming for a started RTMS stream (from meeting.rtms_started). */
  start(stream: RtmsStreamInfo): void {
    if (this.stream) {
      this.log().warn(`rtms: already streaming ${this.stream.streamId}; ignoring ${stream.streamId}`);
      return;
    }
    this.stream = stream;
    this.reconnectAttempts = 0;
    this.lastBySpeaker.clear();
    this.deps.status("waiting", "connecting to Zoom");
    this.connect();
  }

  /** Tear down (rtms_stopped, session finish, or shutdown). Never auto-finishes the session. */
  stop(reason?: string): void {
    if (!this.stream) return;
    this.stream = null;
    this.clearReconnect();
    this.closeSockets();
    this.deps.status("off", reason);
  }

  // ---- connection lifecycle -------------------------------------------------

  private connect(): void {
    const stream = this.stream;
    if (!stream) return;
    if (!this.urlAllowed(stream.serverUrl)) {
      this.log().error(`rtms: refusing non-Zoom signaling url ${stream.serverUrl}`);
      this.deps.status("disconnected", "refused non-Zoom signaling url");
      return;
    }
    this.closeSockets();

    const signaling = new WebSocket(stream.serverUrl);
    this.signalingWs = signaling;

    signaling.on("open", () => {
      this.handshakeSequence += 1;
      this.send(signaling, {
        msg_type: MSG_TYPE.SIGNALING_HAND_SHAKE_REQ,
        protocol_version: 1,
        meeting_uuid: stream.meetingUuid,
        rtms_stream_id: stream.streamId,
        sequence: this.handshakeSequence,
        signature: this.signature(stream),
        media_type: MEDIA_TYPE_TRANSCRIPT,
      });
    });
    signaling.on("message", (data) => this.onSignalingMessage(stream, signaling, data));
    signaling.on("error", (err) => this.log().warn(`rtms signaling error: ${String(err)}`));
    signaling.on("close", () => this.onSocketClosed(signaling));
  }

  private onSignalingMessage(stream: RtmsStreamInfo, signaling: WebSocket, data: WebSocket.RawData): void {
    const msg = this.parse(data);
    if (!msg) return;
    switch (msg.msg_type) {
      case MSG_TYPE.SIGNALING_HAND_SHAKE_RESP: {
        if (msg.status_code !== STATUS_OK) {
          this.log().error(`rtms signaling handshake failed: status ${String(msg.status_code)}`);
          this.deps.status("disconnected", `signaling handshake failed (${String(msg.status_code)})`);
          return;
        }
        const mediaUrl = (msg as { media_server?: { server_urls?: { all?: string } } }).media_server
          ?.server_urls?.all;
        if (!mediaUrl) {
          this.log().error("rtms signaling response had no media server url");
          this.deps.status("disconnected", "no media server url");
          return;
        }
        this.connectMedia(stream, signaling, mediaUrl);
        return;
      }
      case MSG_TYPE.KEEP_ALIVE_REQ:
        this.send(signaling, { msg_type: MSG_TYPE.KEEP_ALIVE_RESP, timestamp: msg.timestamp });
        return;
      default:
        return;
    }
  }

  private connectMedia(stream: RtmsStreamInfo, signaling: WebSocket, mediaUrl: string): void {
    if (!this.urlAllowed(mediaUrl)) {
      this.log().error(`rtms: refusing non-Zoom media url ${mediaUrl}`);
      this.deps.status("disconnected", "refused non-Zoom media url");
      return;
    }
    const media = new WebSocket(mediaUrl);
    this.mediaWs = media;

    media.on("open", () => {
      this.send(media, {
        msg_type: MSG_TYPE.DATA_HAND_SHAKE_REQ,
        protocol_version: 1,
        meeting_uuid: stream.meetingUuid,
        rtms_stream_id: stream.streamId,
        signature: this.signature(stream),
        media_type: MEDIA_TYPE_TRANSCRIPT,
        payload_encryption: false,
        media_params: { transcript: { content_type: CONTENT_TYPE_TEXT } },
      });
    });
    media.on("message", (data) => {
      const msg = this.parse(data);
      if (!msg) return;
      if (msg.msg_type === MSG_TYPE.DATA_HAND_SHAKE_RESP) {
        if (msg.status_code !== STATUS_OK) {
          this.log().error(`rtms data handshake failed: status ${String(msg.status_code)}`);
          this.deps.status("disconnected", `data handshake failed (${String(msg.status_code)})`);
          return;
        }
        // CLIENT_READY_ACK goes on the SIGNALING socket and starts the media flow.
        this.send(signaling, { msg_type: MSG_TYPE.CLIENT_READY_ACK, rtms_stream_id: stream.streamId });
        this.reconnectAttempts = 0;
        this.deps.status("connected");
        return;
      }
      this.handleMediaMessage(msg);
    });
    media.on("error", (err) => this.log().warn(`rtms media error: ${String(err)}`));
    media.on("close", () => this.onSocketClosed(media));
  }

  /** Media-socket message handling (exported for unit tests via handleMediaMessage). */
  handleMediaMessage(msg: Record<string, unknown>): void {
    if (msg.msg_type === MSG_TYPE.KEEP_ALIVE_REQ) {
      if (this.mediaWs) this.send(this.mediaWs, { msg_type: MSG_TYPE.KEEP_ALIVE_RESP, timestamp: msg.timestamp });
      return;
    }
    if (msg.msg_type !== MSG_TYPE.MEDIA_DATA_TRANSCRIPT) return;

    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    const speaker = typeof msg.user_name === "string" && msg.user_name ? msg.user_name : "Zoom";
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    if (!text) return;

    // Duplicate suppression: after a reconnect Zoom may re-deliver recent messages.
    const last = this.lastBySpeaker.get(speaker);
    if (last && ts <= last.ts && text === last.text) return;
    this.lastBySpeaker.set(speaker, { ts, text });

    this.deps.sink({ speaker, text, ts: new Date(ts).toISOString() });
  }

  // ---- reconnect ------------------------------------------------------------

  private onSocketClosed(socket: WebSocket): void {
    // Expected during stop()/reconnect churn; only react while a stream is active
    // and the socket that closed is still the current one (not one we replaced).
    if (!this.stream || this.reconnectTimer) return;
    if (socket !== this.signalingWs && socket !== this.mediaWs) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log().error("rtms: giving up after max reconnect attempts");
      this.deps.status("disconnected", "gave up reconnecting");
      return;
    }
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
    );
    const delay = backoff + Math.floor(Math.random() * 250);
    this.deps.status("disconnected", `reconnecting (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSockets(): void {
    // Null the fields first so close events from these sockets are ignored.
    const { signalingWs, mediaWs } = this;
    this.signalingWs = null;
    this.mediaWs = null;
    for (const ws of [signalingWs, mediaWs]) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }
  }

  // ---- helpers --------------------------------------------------------------

  private urlAllowed(url: string): boolean {
    return this.deps.allowInsecureUrls === true || isAllowedRtmsUrl(url);
  }

  private signature(stream: RtmsStreamInfo): string {
    return handshakeSignature(
      this.deps.credentials.clientId,
      this.deps.credentials.clientSecret,
      stream.meetingUuid,
      stream.streamId,
    );
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private parse(data: WebSocket.RawData): Record<string, unknown> | null {
    try {
      return JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private log(): Pick<Console, "info" | "warn" | "error"> {
    return this.deps.log ?? console;
  }
}

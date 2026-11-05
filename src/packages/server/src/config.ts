/**
 * Per-agent steering (always-on domain knowledge composed into the system prompt)
 * and skills (situational techniques loaded from .claude/skills via settingSources).
 * See plan: Steering & Skills → SDK mapping.
 */

export interface AgentProfile {
  /** Steering doc basenames in /steering (without .md). */
  steering: string[];
  /** Skill folder names under .claude/skills that this agent may use. */
  skills: string[];
  /** Model alias passed to the Agent SDK. */
  model: string;
}

export const AGENTS = {
  synthesizer: {
    steering: ["eventstorming", "ddd"],
    skills: ["connect-the-dots", "surface-vagueness", "find-contradictions", "surface-assumptions"],
    // Sonnet with thinking disabled: fast (2–8s) and high quality. Extended thinking was the
    // bottleneck (30–60s); disabling it makes model choice far less important for latency.
    model: "claude-sonnet-5",
  },
  coach: {
    steering: ["eventstorming", "ddd"],
    skills: ["assess-domain-model", "surface-vagueness", "surface-assumptions"],
    // Coach is user-triggered and benefits from stronger reasoning.
    model: "claude-sonnet-5",
  },
  hints: {
    steering: ["eventstorming", "ddd"],
    skills: [], // steering encodes what it needs; live skills would slow the background pass
    // Background guidance: needs judgment (what's worth interrupting for), not speed.
    model: "claude-sonnet-5",
  },
} as const satisfies Record<string, AgentProfile>;

/** Coach Hints background generation. */
export const HINTS_CONFIG = {
  enabled: (process.env.HINTS_ENABLED ?? "true") !== "false",
  /** Most `active` hints at any time; passes are skipped at the cap. */
  maxActive: 3,
  /** Quiet time after session activity before a pass may run (ms). */
  debounceMs: 30_000,
  /** Hard floor between passes (ms) — hints should be occasional. */
  minIntervalMs: 60_000,
  /** New transcript chunks required since the last pass. */
  minNewChunks: 4,
};

/**
 * Coach proactive (deep) assessment cadence — deliberately mirrors HINTS_CONFIG above: a short
 * trailing debounce so a burst of chunks yields one review, plus a hard floor so continuous
 * conversation cannot chain reviews back to back. Without the floor the cadence is set by the
 * event triggers, not by any interval: every transcript.chunk arms the debounce, and the run's
 * own completion re-arms it, so during a replay reviews run almost continuously.
 */
export const COACH_CONFIG = {
  /** Quiet time after new evidence before a deep review is attempted (ms). */
  assessmentDebounceMs: 1_500,
  /** Hard floor between deep reviews (ms), measured from the END of the previous one. */
  assessmentMinIntervalMs: 60_000,
  enabled: (process.env.COACH_ENABLED ?? "true") !== "false",
};

export type AgentName = keyof typeof AGENTS;

/** Zoom RTMS live transcription. Disabled unless ZOOM_RTMS_ENABLED=true. */
export const ZOOM_CONFIG = {
  enabled: process.env.ZOOM_RTMS_ENABLED === "true",
  clientId: process.env.ZOOM_CLIENT_ID ?? "",
  clientSecret: process.env.ZOOM_CLIENT_SECRET ?? "",
  webhookSecretToken: process.env.ZOOM_WEBHOOK_SECRET_TOKEN ?? "",
  /** Dev/demo only: allow non-Zoom (e.g. ws://127.0.0.1 stub) RTMS URLs. */
  allowInsecureUrls: process.env.ZOOM_RTMS_ALLOW_INSECURE_URLS === "true",
};

/**
 * Mural board projection. Requires a registered Mural OAuth app (account avatar →
 * "Create and manage apps"); Mural has no API keys, so OAuth is mandatory.
 * Redirect URL must exactly match the one registered on the app.
 */
export const MURAL_CONFIG = {
  clientId: process.env.MURAL_CLIENT_ID ?? "",
  clientSecret: process.env.MURAL_CLIENT_SECRET ?? "",
  redirectUri:
    process.env.MURAL_REDIRECT_URI ?? "http://127.0.0.1:8787/api/mural/callback",
  apiBase: "https://app.mural.co/api/public/v1",
  authorizeUrl: "https://app.mural.co/api/public/v1/authorization/oauth2/",
  tokenUrl: "https://app.mural.co/api/public/v1/authorization/oauth2/token",
  scopes: "murals:read murals:write",
  /**
   * Board writes go through the vendored mcp-mural MCP server (spawned as
   * `uv run mural-mcp` in this directory). Override only if it lives elsewhere.
   */
  mcpRepoPath: process.env.MURAL_MCP_REPO ?? new URL("../../../mcp-mural", import.meta.url).pathname,
  /** Trailing debounce after canvas.updated before a projection pass (ms). */
  debounceMs: 500,
};

export const SERVER_CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  /** Heartbeat interval for SSE keep-alive (ms). */
  heartbeatMs: 15_000,
  /** Repo root (where .claude/ and steering/ live); cwd for Agent SDK skill loading. */
  repoRoot: new URL("../../../", import.meta.url).pathname,
};

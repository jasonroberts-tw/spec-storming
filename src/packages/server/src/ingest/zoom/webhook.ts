import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Zoom webhook plumbing: URL-validation challenge and request signature checks.
 * Pure functions so they can be unit-tested with fixed secrets; the Fastify
 * route in index.ts owns transport concerns.
 */

/** Default freshness window for webhook timestamps (Zoom recommends ~5 min). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

/**
 * Whether a value looks like a genuine Zoom `plainToken` (a short URL-safe
 * random string, e.g. "qgg8vlvZRS6UYooatFL8Aw"). Crucially this excludes the
 * `:`-delimited signature preimage `v0:{ts}:{body}` — url_validation is an
 * unauthenticated signing oracle over HMAC(secret, plainToken), and rejecting
 * colon-bearing tokens prevents an attacker steering it onto the exact string
 * used to forge webhook signatures.
 */
export function isPlausiblePlainToken(token: string): boolean {
  return token.length > 0 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

/** Response body for Zoom's `endpoint.url_validation` challenge. */
export function answerUrlValidation(
  plainToken: string,
  webhookSecretToken: string,
): { plainToken: string; encryptedToken: string } {
  const encryptedToken = createHmac("sha256", webhookSecretToken)
    .update(plainToken)
    .digest("hex");
  return { plainToken, encryptedToken };
}

/**
 * Verify the `x-zm-signature` header: `v0=` + HMAC-SHA256 hex of
 * `v0:{x-zm-request-timestamp}:{raw body}` keyed with the webhook secret token.
 */
export function verifyWebhookSignature(input: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  webhookSecretToken: string;
  /** Reject timestamps skewed more than this from now (seconds). Default 5 min. */
  toleranceSeconds?: number;
  /** Injectable clock (ms) for tests; defaults to Date.now(). */
  nowMs?: number;
}): boolean {
  if (!input.signature || !input.timestamp) return false;
  // Reject stale/forged-future timestamps to blunt replay of a captured request.
  const tsSeconds = Number(input.timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_S;
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return false;
  const expected = `v0=${createHmac("sha256", input.webhookSecretToken)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  const a = Buffer.from(input.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

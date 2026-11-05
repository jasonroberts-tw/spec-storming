import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { answerUrlValidation, isPlausiblePlainToken, verifyWebhookSignature } from "./webhook.ts";

const SECRET = "test-webhook-secret";
// Fixed clock so the freshness window is deterministic; ts values sit near it.
const NOW_MS = 1_722_600_000_000;
const TS = "1722600000"; // NOW_MS / 1000

test("url validation returns plainToken with its HMAC-SHA256 hex", () => {
  const res = answerUrlValidation("abc123", SECRET);
  assert.equal(res.plainToken, "abc123");
  assert.equal(
    res.encryptedToken,
    createHmac("sha256", SECRET).update("abc123").digest("hex"),
  );
});

function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

test("valid signature within the freshness window passes", () => {
  const rawBody = JSON.stringify({ event: "meeting.rtms_started", payload: {} });
  assert.equal(
    verifyWebhookSignature({ signature: sign(TS, rawBody), timestamp: TS, rawBody, webhookSecretToken: SECRET, nowMs: NOW_MS }),
    true,
  );
});

test("signature computed with wrong secret fails", () => {
  const rawBody = "{}";
  assert.equal(
    verifyWebhookSignature({
      signature: sign(TS, rawBody, "wrong-secret"),
      timestamp: TS,
      rawBody,
      webhookSecretToken: SECRET,
      nowMs: NOW_MS,
    }),
    false,
  );
});

test("signature over different body fails", () => {
  assert.equal(
    verifyWebhookSignature({
      signature: sign(TS, "{}"),
      timestamp: TS,
      rawBody: '{"tampered":true}',
      webhookSecretToken: SECRET,
      nowMs: NOW_MS,
    }),
    false,
  );
});

test("missing signature or timestamp fails", () => {
  assert.equal(
    verifyWebhookSignature({ signature: undefined, timestamp: TS, rawBody: "{}", webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
  assert.equal(
    verifyWebhookSignature({ signature: "v0=abc", timestamp: undefined, rawBody: "{}", webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
});

test("malformed signature of different length fails without throwing", () => {
  assert.equal(
    verifyWebhookSignature({ signature: "v0=short", timestamp: TS, rawBody: "{}", webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
});

test("stale timestamp is rejected even with an otherwise-valid signature", () => {
  const rawBody = "{}";
  const staleTs = String(NOW_MS / 1000 - 600); // 10 min old, window is 5 min
  assert.equal(
    verifyWebhookSignature({ signature: sign(staleTs, rawBody), timestamp: staleTs, rawBody, webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
});

test("far-future timestamp is rejected", () => {
  const rawBody = "{}";
  const futureTs = String(NOW_MS / 1000 + 3600);
  assert.equal(
    verifyWebhookSignature({ signature: sign(futureTs, rawBody), timestamp: futureTs, rawBody, webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
});

test("non-numeric timestamp is rejected", () => {
  assert.equal(
    verifyWebhookSignature({ signature: "v0=abc", timestamp: "not-a-number", rawBody: "{}", webhookSecretToken: SECRET, nowMs: NOW_MS }),
    false,
  );
});

test("plausible plainToken accepts real Zoom tokens, rejects signature preimages", () => {
  assert.equal(isPlausiblePlainToken("qgg8vlvZRS6UYooatFL8Aw"), true);
  assert.equal(isPlausiblePlainToken("abc-123_XYZ"), true);
  // The signing-oracle vector: a signature preimage `v0:{ts}:{body}` must be refused.
  assert.equal(isPlausiblePlainToken("v0:1722600000:{}"), false);
  assert.equal(isPlausiblePlainToken(""), false);
  assert.equal(isPlausiblePlainToken("a".repeat(129)), false);
});

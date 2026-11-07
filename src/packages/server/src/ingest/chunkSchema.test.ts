import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { ingestChunkSchema } from "./chunkSchema.ts";

// Characterization: the `ts` forms POST /api/ingest/chunk accepted under zod 3, which the route's
// spec promises as "an optional ISO ts". A zod upgrade must keep every row.
const tsCases: Array<[string, boolean]> = [
  ["2026-01-01T10:00:00Z", true],
  ["2026-01-01T10:00:00.123Z", true],
  ["2026-01-01T10:00:00+02:00", true],
  ["2026-01-01T10:00:00+0200", true],
  ["2026-01-01T10:00Z", true],
  ["2026-01-01T10:00+02:00", true],
  ["2026-01-01T10:00:00-23:59", true],
  ["2026-01-01T10:00:00+24:00", true],
  ["2026-01-01T10:00:00+99:99", true],
  ["2026-02-29T10:00:00Z", false],
  ["2026-01-01T10:00:00+02", false],
  ["2026-01-01T10:00:00", false],
  ["2026-01-01", false],
  ["not a date", false],
];

for (const [ts, accepted] of tsCases) {
  test(`ts ${JSON.stringify(ts)} is ${accepted ? "accepted" : "refused"}`, () => {
    strictEqual(ingestChunkSchema.safeParse({ speaker: "Ana", text: "Order placed", ts }).success, accepted);
  });
}

test("ts is optional, and speaker and text are trimmed", () => {
  const parsed = ingestChunkSchema.safeParse({ speaker: "  Ana ", text: " Order placed  " });
  deepStrictEqual(parsed.success ? parsed.data : parsed.error.issues, { speaker: "Ana", text: "Order placed" });
});

test("a blank speaker or text gets the route's own message", () => {
  const parsed = ingestChunkSchema.safeParse({ speaker: " ", text: "" });
  deepStrictEqual(
    parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    ["speaker required", "text required"],
  );
});

test("a refused ts says it is not a datetime", () => {
  const parsed = ingestChunkSchema.safeParse({ speaker: "Ana", text: "Order placed", ts: "2026-01-01" });
  deepStrictEqual(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message), ["Invalid datetime"]);
});

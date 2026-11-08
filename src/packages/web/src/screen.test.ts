import assert from "node:assert/strict";
import { test } from "node:test";
import { screenFromHash } from "./screen.ts";

test("screenFromHash shows the coach for #coach", () => {
  assert.equal(screenFromHash("#coach"), "coach");
});

test("screenFromHash shows the canvas for #canvas", () => {
  assert.equal(screenFromHash("#canvas"), "canvas");
});

test("screenFromHash shows the canvas when the URL has no hash, or one it does not know", () => {
  assert.equal(screenFromHash(""), "canvas");
  assert.equal(screenFromHash("#specs"), "canvas");
  assert.equal(screenFromHash("coach"), "canvas");
});

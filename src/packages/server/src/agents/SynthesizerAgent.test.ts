/**
 * Watermark advance rule. A batch dispatches several windows in parallel; the synthesized-through
 * seq may only move across windows that actually landed. Advancing past a failed window marks its
 * chunks synthesized and they are never retried — the bug that froze a demo canvas at 3 stickies
 * while lastSynthesizedSeq claimed all 90 chunks were covered.
 */

import { strictEqual } from "node:assert";
import { test } from "node:test";
import type { TranscriptChunk } from "@specstorming/shared";
import { watermarkAfterBatch } from "./SynthesizerAgent.ts";

/** Windows of consecutive seqs, e.g. windowsOf([1,3],[4,6]) → seqs 1-3 and 4-6. */
function windowsOf(...ranges: [number, number][]): TranscriptChunk[][] {
  return ranges.map(([from, to]) => {
    const chunks: TranscriptChunk[] = [];
    for (let seq = from; seq <= to; seq++) {
      chunks.push({
        id: `t-${String(seq).padStart(4, "0")}`,
        seq,
        speaker: "Dev",
        text: `line ${seq}`,
        ts: new Date(0).toISOString(),
      });
    }
    return chunks;
  });
}

test("advances to the end of the last window when every window succeeds", () => {
  const windows = windowsOf([1, 3], [4, 6], [7, 9]);
  strictEqual(watermarkAfterBatch(windows, [true, true, true], 0), 9);
});

test("does not advance at all when the first window fails", () => {
  const windows = windowsOf([1, 3], [4, 6], [7, 9]);
  // Windows 2 and 3 succeeded, but their chunks sit behind a gap — redoing them next batch is
  // cheap (id-keyed upserts), whereas skipping window 1 loses seqs 1-3 permanently.
  strictEqual(watermarkAfterBatch(windows, [false, true, true], 0), 0);
});

test("stops at the first failure rather than skipping over it", () => {
  const windows = windowsOf([1, 3], [4, 6], [7, 9]);
  strictEqual(watermarkAfterBatch(windows, [true, false, true], 0), 3);
});

test("never moves the watermark backwards", () => {
  const windows = windowsOf([10, 12]);
  strictEqual(watermarkAfterBatch(windows, [false], 7), 7);
});

test("the regression itself: an all-failed batch leaves the whole backlog queued", () => {
  const windows = windowsOf([4, 28], [29, 53], [54, 78], [79, 90]);
  strictEqual(watermarkAfterBatch(windows, [false, false, false, false], 3), 3);
});

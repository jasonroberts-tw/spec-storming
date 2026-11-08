import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatMessage } from "@specstorming/shared";
import { latestAssessmentMessage, scoreBand } from "./assessment.ts";

describe("scoreBand", () => {
  test("puts 3 in the low band and 4 in the medium band", () => {
    assert.equal(scoreBand(3), "low");
    assert.equal(scoreBand(4), "medium");
  });

  test("puts 7 in the medium band and 8 in the complete band", () => {
    assert.equal(scoreBand(7), "medium");
    assert.equal(scoreBand(8), "complete");
  });

  test("puts the ends of the scale in the outer bands", () => {
    assert.equal(scoreBand(0), "low");
    assert.equal(scoreBand(10), "complete");
  });
});

/** An assessment message; a `provisional-` id gets the prefix the server gives a provisional one. */
const assessment = (id: string, canvasRevision?: number, transcriptSeq?: number): ChatMessage => ({
  id: id.startsWith("provisional-") ? `assessment-${id}` : id,
  role: "coach",
  text: "",
  ts: "2026-11-08T10:00:00.000Z",
  kind: "assessment",
  canvasRevision,
  transcriptSeq,
});

const conversation = (id: string, canvasRevision: number): ChatMessage => ({
  id,
  role: "coach",
  text: "an answer",
  ts: "2026-11-08T10:00:00.000Z",
  kind: "conversation",
  canvasRevision,
});

const pick = (...messages: ChatMessage[]) => latestAssessmentMessage(messages)?.id;

describe("latestAssessmentMessage", () => {
  test("returns nothing when the chat holds no assessment", () => {
    assert.equal(pick(), undefined);
    assert.equal(pick(conversation("c1", 9)), undefined);
  });

  test("ignores conversation messages, whatever revision they carry", () => {
    assert.equal(pick(assessment("deep-a", 1, 1), conversation("c1", 9)), "deep-a");
  });

  test("picks the higher canvas revision, wherever it sits in the chat", () => {
    assert.equal(pick(assessment("deep-a", 5, 1), assessment("deep-b", 4, 1)), "deep-a");
    assert.equal(pick(assessment("deep-a", 4, 1), assessment("deep-b", 5, 1)), "deep-b");
  });

  test("compares the revision before the transcript sequence", () => {
    assert.equal(pick(assessment("deep-a", 4, 99), assessment("deep-b", 5, 1)), "deep-b");
  });

  test("picks the higher transcript sequence when the revisions tie", () => {
    assert.equal(pick(assessment("deep-a", 5, 12), assessment("deep-b", 5, 11)), "deep-a");
    assert.equal(pick(assessment("deep-a", 5, 11), assessment("deep-b", 5, 12)), "deep-b");
  });

  test("picks the deep review over the provisional one when revision and sequence tie", () => {
    assert.equal(pick(assessment("provisional-a", 5, 12), assessment("deep-b", 5, 12)), "deep-b");
    assert.equal(pick(assessment("deep-a", 5, 12), assessment("provisional-b", 5, 12)), "deep-a");
  });

  test("a later provisional assessment still wins on a higher revision", () => {
    assert.equal(pick(assessment("deep-a", 5, 12), assessment("provisional-b", 6, 1)), "assessment-provisional-b");
  });

  test("keeps the first of two assessments of the same kind that tie on everything", () => {
    assert.equal(pick(assessment("deep-a", 5, 12), assessment("deep-b", 5, 12)), "deep-a");
    assert.equal(pick(assessment("provisional-a", 5, 12), assessment("provisional-b", 5, 12)), "assessment-provisional-a");
  });

  test("counts a missing revision or sequence as 0", () => {
    assert.equal(pick(assessment("deep-a"), assessment("deep-b", 0, 1)), "deep-b");
    assert.equal(pick(assessment("deep-a", 1), assessment("deep-b", 0, 50)), "deep-a");
    // A missing revision ties an explicit 0, so the sequence decides, in either order.
    assert.equal(pick(assessment("deep-a", undefined, 5), assessment("deep-b", 0, 1)), "deep-a");
    assert.equal(pick(assessment("deep-a", 0, 1), assessment("deep-b", undefined, 5)), "deep-b");
    // A missing sequence ties an explicit 0, so the tie-break decides, in either order.
    assert.equal(pick(assessment("deep-a", 3), assessment("deep-b", 3, 0)), "deep-a");
    assert.equal(pick(assessment("provisional-a", 3, 0), assessment("deep-b", 3)), "deep-b");
  });
});

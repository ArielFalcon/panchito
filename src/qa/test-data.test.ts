import { test } from "node:test";
import assert from "node:assert/strict";
import { testDataNamespace, shortSha } from "./test-data";

const SHA = "abc1234567890";

test("namespace uses prefix + short sha (no runId: backward-compatible form)", () => {
  assert.equal(testDataNamespace("qa-bot", SHA), "qa-bot-abc1234");
});

test("namespace appends a per-run token from the runId so two runs of the SAME sha differ", () => {
  const a = testDataNamespace("qa-bot", SHA, "run-abc1234-loyw3v28");
  const b = testDataNamespace("qa-bot", SHA, "run-abc1234-loyw3v99");
  assert.notEqual(a, b); // no same-sha DEV-data collision across runs
  assert.match(a, /^qa-bot-abc1234-/); // still prefix + short sha, plus the run token
});

test("shortSha trims to 7", () => {
  assert.equal(shortSha(SHA), "abc1234");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { progressBar, stepState, verdictColor, verdictIcon, caseIcon, shortSha } from "./format";

test("progressBar fills proportionally and clamps", () => {
  assert.equal(progressBar(0, 0).length, 20);
  assert.match(progressBar(0, 0), /^░{20}$/);
  assert.equal(progressBar(1, 1), "▓".repeat(20));
  const half = progressBar(2, 4);
  assert.equal(half.length, 20);
  assert.equal([...half].filter((c) => c === "▓").length, 10);
});

test("stepState marks earlier steps done, the current active, later pending", () => {
  assert.equal(stepState("validate", "classify"), "done");
  assert.equal(stepState("validate", "generate"), "done");
  assert.equal(stepState("validate", "validate"), "active");
  assert.equal(stepState("validate", "execute"), "pending");
});

test("stepState: done marks everything done; retry keeps execute active", () => {
  assert.equal(stepState("done", "classify"), "done");
  assert.equal(stepState("done", "execute"), "done");
  assert.equal(stepState("retry", "validate"), "done");
  assert.equal(stepState("retry", "execute"), "active");
});

test("verdictColor / verdictIcon map verdicts", () => {
  assert.equal(verdictColor("pass"), "#3b7a57");
  assert.equal(verdictColor("fail"), "#c0392b");
  assert.equal(verdictColor("infra-error"), "#4a6877");
  assert.equal(verdictColor(undefined), "cyan");
  assert.equal(verdictIcon("pass"), "✓");
  assert.equal(verdictIcon("fail"), "✗");
  assert.equal(verdictIcon("skipped"), "⊘");
});

test("caseIcon and shortSha", () => {
  assert.equal(caseIcon("fail"), "✗");
  assert.equal(caseIcon("pass"), "✓");
  assert.equal(shortSha("abcdef1234567890"), "abcdef1");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunContext } from "./chat";
import { RunRecord } from "../types";

const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "r1",
  app: "portfolio",
  sha: "abcdef1234567890",
  target: "e2e",
  mode: "diff",
  status: "done",
  verdict: "fail",
  passed: 1,
  failed: 1,
  cases: [
    { name: "login", status: "pass" },
    { name: "checkout", status: "fail", detail: "timed out waiting for the pay button" },
  ],
  logs: ["[qa] running...", "leaked password=hunter2 in a log line"],
  at: "t",
  ...over,
});

test("buildRunContext includes verdict + failing case detail, and is sanitized on ingress", () => {
  const ctx = buildRunContext(rec());
  assert.match(ctx, /Verdict: fail/);
  assert.match(ctx, /checkout/);
  assert.match(ctx, /timed out/);
  assert.doesNotMatch(ctx, /hunter2/); // a secret in the logs is redacted
});

test("buildRunContext caps the case list and reports the overflow", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, status: "pass" as const }));
  const ctx = buildRunContext(rec({ cases: many }), { maxCases: 5, caseDetailChars: 50, logTailChars: 100 });
  assert.match(ctx, /and 25 more/);
});

test("buildRunContext includes the note when present", () => {
  const ctx = buildRunContext(rec({ note: "retry exhausted" }));
  assert.match(ctx, /Note: retry exhausted/);
});

test("buildRunContext shows 'running' when verdict is undefined", () => {
  const ctx = buildRunContext(rec({ verdict: undefined }));
  assert.match(ctx, /Verdict: running/);
});

test("buildRunContext omits cases section when there are none", () => {
  const ctx = buildRunContext(rec({ cases: [] }));
  assert.doesNotMatch(ctx, /Cases:/);
});

test("buildRunContext omits logs section when logs are empty", () => {
  const ctx = buildRunContext(rec({ logs: [] }));
  assert.doesNotMatch(ctx, /Logs/);
});

test("buildRunContext preserves complete log lines — does not split mid-line", () => {
  const lineOne = "first-line";
  const lineTwo = ".".repeat(200);
  const lineThree = "last";
  const budgetFitsTwo = lineTwo.length + lineThree.length + 10;

  const ctx = buildRunContext(
    rec({ logs: [lineOne, lineTwo, lineThree] }),
    { maxCases: 0, caseDetailChars: 50, logTailChars: budgetFitsTwo },
  );

  assert.match(ctx, new RegExp(lineThree));
  assert.match(ctx, new RegExp(lineTwo));
  assert.doesNotMatch(ctx, new RegExp(lineOne));
});

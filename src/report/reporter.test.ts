import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue, renderPrBody } from "./reporter";

test("Issue leads with a high-level headline, what-was-tested and findings — not a log dump", () => {
  const body = renderIssue(
    {
      sha: "abc123",
      verdict: "fail",
      passed: false,
      cases: [
        { name: "login ok", status: "pass" },
        { name: "checkout", status: "fail", detail: "Error: locator.click timeout 30000ms exceeded\n  at line 5\n  call log..." },
      ],
      logs: "verbose playwright output line 1\nline 2\nline 3",
    },
    {
      note: "checkout.spec.ts: no assertion verifies the discount; login.spec.ts: scope the Pay selector",
      tested: [{ flow: "checkout", objective: "buying a product completes the order" }],
      intent: { type: "fix", message: "null pointer on empty checkout", changedFiles: ["a.ts", "b.ts"] },
    },
  );
  // structure + high-level sections
  assert.match(body, /## QA —/);
  assert.match(body, /1 of 2 check\(s\) failed/);
  assert.match(body, /\*\*Change:\*\* `fix` — null pointer on empty checkout \(2 files\)/);
  assert.match(body, /### What was tested[\s\S]*buying a product completes the order/);
  assert.match(body, /### Failing cases[\s\S]*\*\*checkout\*\* — Error: locator\.click timeout/);
  assert.match(body, /### Findings[\s\S]*no assertion verifies the discount/);
  assert.match(body, /- login\.spec\.ts: scope the Pay selector/); // "; " corrections split into bullets
  // the cause is ONE line — the stack tail is not inlined
  assert.doesNotMatch(body, /\*\*checkout\*\* —[^\n]*call log/);
  // logs are demoted to a collapsed appendix, not the headline
  assert.match(body, /<details>\s*\n<summary>Run logs/);
  assert.match(body, /verbose playwright output/);
  // passing case is not listed
  assert.doesNotMatch(body, /login ok/);
});

test("sanitizes secrets in logs, case details and the note before they reach a public Issue", () => {
  const body = renderIssue(
    {
      sha: "abc123",
      verdict: "fail",
      passed: false,
      cases: [{ name: "x", status: "fail", detail: "leaked DEV_TEST_PASS=hunter2 here" }],
      logs: "build log with GITHUB_TOKEN=ghp_secretvalue inside",
    },
    { note: "saw AWS key AKIAIOSFODNN7EXAMPLE in the run" },
  );
  assert.doesNotMatch(body, /hunter2/);
  assert.doesNotMatch(body, /ghp_secretvalue/);
  assert.doesNotMatch(body, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(body, /\[REDACTED_SECRET\]/);
});

test("a run with no cases, no note and no logs still renders a valid headline", () => {
  const body = renderIssue({ sha: "x", verdict: "invalid", passed: false, cases: [], logs: "" });
  assert.match(body, /could not be validated/);
  assert.doesNotMatch(body, /<details>/); // no empty logs appendix
});

test("budgets an oversized log so the body stays under GitHub's 65536-char limit, keeping the tail", () => {
  // Realistic log shape: many short lines (not one giant contiguous base64-char run,
  // which would be flagged by the sanitizer's base64-secret rule). The marker lives
  // at the tail so we can prove head+tail truncation keeps the failing region.
  const huge = "verbose log line\n".repeat(20_000) + "FINAL_ERROR_MARKER";
  const body = renderIssue(
    { sha: "abc123", verdict: "fail", passed: false, cases: [{ name: "c", status: "fail", detail: "boom" }], logs: huge },
    { note: "the run did not converge" },
  );
  assert.ok(body.length <= 65536, `body length ${body.length} should be <= 65536`);
  assert.match(body, /FINAL_ERROR_MARKER/); // the tail (where the failure is) survives
  assert.match(body, /chars omitted/); // truncation is signalled, not silent
  assert.match(body, /abc123/); // structure preserved
  assert.match(body, /Trace available in the run artifacts/);
});

test("caps a flood of failed cases instead of letting the body balloon", () => {
  const cases = Array.from({ length: 500 }, (_, i) => ({
    name: `case-${i}`,
    status: "fail" as const,
    detail: "d".repeat(50_000),
  }));
  const body = renderIssue({ sha: "abc123", verdict: "fail", passed: false, cases, logs: "" });
  assert.ok(body.length <= 65536, `body length ${body.length} should be <= 65536`);
  assert.match(body, /more failed case\(s\) omitted/);
});

test("PR body documents what the suite covers and how it was validated — no logs", () => {
  const body = renderPrBody({
    sha: "abc123",
    isCode: false,
    tested: [
      { flow: "checkout", objective: "a cart with >10 items applies the bulk discount" },
      { flow: "login", objective: "valid credentials reach the dashboard" },
    ],
    parentRunId: "run-deadbeef",
  });
  assert.match(body, /## What this PR adds/);
  assert.match(body, /E2E tests generated\/updated by ai-pipeline for `abc123`/);
  assert.match(body, /\*\*Covers:\*\*[\s\S]*\*\*checkout\*\* — a cart with >10 items/);
  assert.match(body, /\*\*Validation:\*\* harness green/);
  assert.match(body, /Continuation of run-deadbeef/);
});

test("PR body for code mode states the exit-code validation and omits the covers list when empty", () => {
  const body = renderPrBody({ sha: "abc123", isCode: true });
  assert.match(body, /Source-code tests generated/);
  assert.match(body, /the repo's own test suite passed \(exit code 0\)/);
  assert.doesNotMatch(body, /\*\*Covers:\*\*/);
});

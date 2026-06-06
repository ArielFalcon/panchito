import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue } from "./reporter";

test("includes SHA, failed cases (what/how/fix) and logs", () => {
  const body = renderIssue(
    {
      sha: "abc123",
      verdict: "fail",
      passed: false,
      cases: [
        { name: "login ok", status: "pass" },
        { name: "checkout", status: "fail", detail: "timeout", objective: "buy a product", flow: "/checkout", reason: "scope the selector to the cart section" },
      ],
      logs: "sanitized output",
    },
    "did not converge in maxIterations",
  );
  assert.match(body, /abc123/);
  assert.match(body, /checkout/);
  assert.match(body, /How it failed.*timeout/);
  assert.match(body, /What was tested.*buy a product/);
  assert.match(body, /Proposed fix.*scope the selector/);
  assert.match(body, /did not converge/);
  assert.match(body, /sanitized output/);
  assert.doesNotMatch(body, /login ok/); // only lists the failed ones
});

test("sanitizes secrets in logs and case details before they reach a public Issue", () => {
  const body = renderIssue({
    sha: "abc123",
    verdict: "invalid",
    passed: false,
    cases: [{ name: "x", status: "fail", detail: "leaked DEV_TEST_PASS=hunter2 here" }],
    logs: "build log with GITHUB_TOKEN=ghp_secretvalue inside",
  });
  assert.doesNotMatch(body, /hunter2/);
  assert.doesNotMatch(body, /ghp_secretvalue/);
  assert.match(body, /\[REDACTED_SECRET\]/);
});

test("a missing reviewer note does not break the render", () => {
  const body = renderIssue({ sha: "x", verdict: "fail", passed: false, cases: [], logs: "" });
  assert.match(body, /no case detail/);
});

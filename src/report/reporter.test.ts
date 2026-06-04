import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue } from "./reporter";

test("includes SHA, failed cases and logs", () => {
  const body = renderIssue(
    {
      sha: "abc123",
      verdict: "fail",
      passed: false,
      cases: [
        { name: "login ok", status: "pass" },
        { name: "checkout", status: "fail", detail: "timeout" },
      ],
      logs: "sanitized output",
    },
    "did not converge in maxIterations",
  );
  assert.match(body, /abc123/);
  assert.match(body, /checkout — timeout/);
  assert.match(body, /did not converge/);
  assert.match(body, /sanitized output/);
  assert.doesNotMatch(body, /login ok/); // only lists the failed ones
});

test("a missing reviewer note does not break the render", () => {
  const body = renderIssue({ sha: "x", verdict: "fail", passed: false, cases: [], logs: "" });
  assert.match(body, /no case detail/);
});

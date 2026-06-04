import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue } from "./reporter";

test("incluye SHA, casos fallidos y logs", () => {
  const body = renderIssue(
    {
      sha: "abc123",
      verdict: "fail",
      passed: false,
      cases: [
        { name: "login ok", status: "pass" },
        { name: "checkout", status: "fail", detail: "timeout" },
      ],
      logs: "salida sanitizada",
    },
    "no convergió en maxIterations",
  );
  assert.match(body, /abc123/);
  assert.match(body, /checkout — timeout/);
  assert.match(body, /no convergió/);
  assert.match(body, /salida sanitizada/);
  assert.doesNotMatch(body, /login ok/); // solo lista los fallidos
});

test("sin nota del revisor no rompe el render", () => {
  const body = renderIssue({ sha: "x", verdict: "fail", passed: false, cases: [], logs: "" });
  assert.match(body, /sin detalle de casos/);
});

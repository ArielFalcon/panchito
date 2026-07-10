// test/contexts/workspace-and-publication/domain/render-publication.test.ts
// sdd/migration-remediation Slice 4 (D-P1a, publication rendering + tested metadata). Pins the
// spec's own 4 acceptance scenarios (publication-rendering domain) directly against the pure
// renderIssue/renderPrBody functions — no sanitizer collaborator needed (see render-publication.ts's
// own header for why sanitize is applied ONCE, by the caller, to the whole composed body).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue, renderPrBody } from "@contexts/workspace-and-publication/domain/render-publication.ts";
import type { QaCase } from "@kernel/qa-case.ts";

function failCase(overrides: Partial<QaCase> = {}): QaCase {
  return { name: "checkout flow", status: "fail", detail: "expect(locator).toBeVisible() failed\nTimeout 5000ms exceeded", ...overrides };
}

// ── Scenario: Failing run renders a distilled Issue, not a log dump ──────────────────────────────

test("renderIssue: a fail run with 3 failing cases shows the headline and capped failing cases with one-line causes", () => {
  const cases: QaCase[] = [
    failCase({ name: "checkout" }),
    failCase({ name: "login", detail: "Error: getByRole resolved to 0 elements" }),
    failCase({ name: "search", detail: "assert(results.length).toBeGreaterThan(0) failed" }),
  ];

  const body = renderIssue({ verdict: "fail", cases });

  assert.match(body, /3 of 3 check\(s\) failed against the live environment/);
  assert.match(body, /### Failing cases/);
  assert.match(body, /\*\*checkout\*\*/);
  // oneLineCause prefers the FIRST line naming an error/assertion — "checkout"'s own detail has
  // its assertion on line 1, so that (not the "Timeout" line 2) is the distilled cause shown.
  assert.match(body, /expect\(locator\)\.toBeVisible\(\) failed/);
  assert.match(body, /Error: getByRole resolved to 0 elements/);
});

test("renderIssue: contains no raw execution-log text (the regression this slice fixes — no logs input exists to embed)", () => {
  const body = renderIssue({ verdict: "fail", cases: [failCase()] });
  // renderIssue's own input shape (RenderIssueInput) carries no `logs` field at all — structural
  // proof that a raw log dump cannot reach the body through this function.
  assert.ok(!body.includes("stdout:"), "no raw log marker text should ever appear");
  assert.match(body, /Full trace \+ logs in the run artifacts/, "the footer points at the run artifacts instead of embedding logs");
});

test("renderIssue: caps failing cases at 50 and reports the omitted count", () => {
  const cases: QaCase[] = Array.from({ length: 55 }, (_, i) => failCase({ name: `case-${i}` }));
  const body = renderIssue({ verdict: "fail", cases });
  assert.match(body, /_…and 5 more failed case\(s\) omitted\._/);
});

test("renderIssue: a flaky verdict renders the quarantine section", () => {
  const cases: QaCase[] = [{ name: "checkout", status: "flaky" }];
  const body = renderIssue({ verdict: "flaky", cases });
  assert.match(body, /### Flaky \(quarantined\)/);
  assert.match(body, /checkout/);
  assert.match(body, /1 test\(s\) were unstable and were quarantined/);
});

test("renderIssue: an invalid verdict renders the static-gate headline", () => {
  const body = renderIssue({ verdict: "invalid", cases: [] });
  assert.match(body, /the generated tests could not be validated \(static gate\)/);
});

// ── Existing engine-adjudication + reviewer-unavailable sections — KEPT (binding rider) ──────────

test("renderIssue: renders an 'Engine adjudication' section when adjudication is present", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [failCase()],
    adjudication: { class: "app_defect", confidence: "high", reason: "backend returned a 5xx" },
  });
  assert.match(body, /Engine adjudication/);
  assert.match(body, /app_defect/);
  assert.match(body, /backend returned a 5xx/);
});

test("renderIssue: words a low-confidence adjudication as an engine guess (hint)", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [],
    adjudication: { class: "generated_test_defect", confidence: "low", reason: "ambiguous failure" },
  });
  assert.match(body, /Engine adjudication \(low confidence — treat as a hint\)/);
});

test("renderIssue: omits the adjudication section entirely when absent", () => {
  const body = renderIssue({ verdict: "fail", cases: [failCase()] });
  assert.ok(!body.includes("Engine adjudication"));
});

test("renderIssue: renders a 'Reviewer unavailable' section when reviewerNote is present", () => {
  const body = renderIssue({ verdict: "pass", cases: [], reviewerNote: "reviewer unavailable: timed out after 360000ms" });
  assert.match(body, /Reviewer unavailable/);
  assert.match(body, /timed out after 360000ms/);
});

test("renderIssue: omits the 'Reviewer unavailable' section entirely when reviewerNote is absent", () => {
  const body = renderIssue({ verdict: "fail", cases: [] });
  assert.ok(!body.includes("Reviewer unavailable"));
});

// ── "What was tested" (Issue) ─────────────────────────────────────────────────────────────────────

test("renderIssue: renders a 'What was tested' section when tested is present", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [failCase()],
    tested: [{ flow: "Checkout", objective: "user can pay with a saved card" }],
  });
  assert.match(body, /### What was tested/);
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /user can pay with a saved card/);
});

// ── Scenario (negative): absent tested metadata does not crash rendering ─────────────────────────

test("renderIssue: a caller that omits tested completes without throwing and omits the section", () => {
  assert.doesNotThrow(() => renderIssue({ verdict: "fail", cases: [] }));
  const body = renderIssue({ verdict: "fail", cases: [] });
  assert.ok(!body.includes("What was tested"));
});

test("renderPrBody: a caller that omits tested completes without throwing and omits the 'Covers:' section", () => {
  assert.doesNotThrow(() => renderPrBody({ isCode: false }));
  const body = renderPrBody({ isCode: false });
  assert.ok(!body.includes("Covers:"));
  assert.match(body, /## What this PR adds/);
  assert.match(body, /\*\*Validation:\*\*/);
});

// ── Scenario: Green run renders a PR body with coverage statement ────────────────────────────────

test("renderPrBody: a green run with tested metadata present renders 'What this PR adds', a matching 'Covers:' list, and the validation statement", () => {
  const body = renderPrBody({
    sha: "abc1234",
    isCode: false,
    tested: [{ flow: "Checkout", objective: "user can pay with a saved card" }, { flow: "Login", objective: "user can sign in" }],
  });

  assert.match(body, /## What this PR adds/);
  assert.match(body, /E2E tests generated\/updated by panchito for `abc1234`/);
  assert.match(body, /\*\*Covers:\*\*/);
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /\*\*Login\*\*/);
  assert.match(body, /\*\*Validation:\*\* harness green/);
});

test("renderPrBody: a code-target run renders the code-flavored wording", () => {
  const body = renderPrBody({ isCode: true, tested: [{ flow: "parseConfig", objective: "rejects malformed YAML" }] });
  assert.match(body, /Source-code tests generated\/updated by panchito\./);
  assert.match(body, /\*\*Validation:\*\* the repo's own test suite passed \(exit code 0\)/);
});

test("renderPrBody: tested items missing flow or objective still render (partial metadata degrades gracefully)", () => {
  const body = renderPrBody({ isCode: false, tested: [{ flow: "Checkout" }, { objective: "no flow name" }] });
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /- no flow name/);
});

// ── Scenario: Continuation run shows provenance ───────────────────────────────────────────────────

test("renderPrBody: a run carrying parentRunId includes a continuation reference", () => {
  const body = renderPrBody({ isCode: false, parentRunId: "run-deadbeef" });
  assert.match(body, /Continuation of run-deadbeef/);
});

test("renderPrBody: omits the continuation reference entirely when parentRunId is absent", () => {
  const body = renderPrBody({ isCode: false });
  assert.ok(!body.includes("Continuation of"));
});

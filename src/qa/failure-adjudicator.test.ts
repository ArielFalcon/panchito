import { test } from "node:test";
import assert from "node:assert/strict";

// RED phase (tasks 1.1 + 1.2): these tests are written BEFORE the module exists.
// They drive the implementation of failure-adjudicator.ts.
import {
  adjudicate,
  classifyRuntimeErrors,
  ADJ_CLASS,
  ADJ_ACTION,
  ADJ_CONFIDENCE,
  type AdjudicatorEvidence,
  type AdjudicatorVerdict,
} from "./failure-adjudicator";
import { PLAYWRIGHT_INFRA_RE } from "./execute";

// ── Helpers ────────────────────────────────────────────────────────────────────

function base(): AdjudicatorEvidence {
  return {
    isCode: false,
    allUnique: false,
    failureDetails: [],
    failureClasses: [],
    absentKeysCount: 0,
    gateSpend: true,
    gateReason: "first retry — baseline established",
    devHealthy: true,
    mode: "diff",
    objectiveSource: [],
    failingFiles: [],
    httpStatuses: [], // D3: per-failed-case attributed 5xx statuses (undefined = absent for that case)
    runtimeErrorsByCase: [], // Feature B: per-failed-case captured console/pageerror events (empty = none captured)
  };
}

// ── R1 — app_defect parity with isLikelyRealBug ───────────────────────────────

test("R1: canonical true case — allUnique + value-mismatch → app_defect/break-issue/high", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [
      "Error: expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'",
    ],
    failureClasses: ["value-mismatch"],
    gateSpend: true,
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, `expected app_defect, got ${v.class}`);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE, `expected break-issue, got ${v.action}`);
  assert.equal(v.confidence, ADJ_CONFIDENCE.HIGH, `expected high, got ${v.confidence}`);
});

test("R1: parity true — toHaveText with echoed locator+timeout (C2) → app_defect", () => {
  const detail =
    "Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByRole('heading')\nExpected string: \"Find Owners\"\nReceived string: \"Owners\"\nTimeout:  5000ms";
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [detail],
    failureClasses: ["value-mismatch"],
    gateSpend: true,
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

test("R1: parity false — allUnique=false → NOT app_defect", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["expect(received).toEqual(expected)"],
    failureClasses: ["value-mismatch"],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, `should not be app_defect when allUnique=false`);
});

test("R1: parity false — mixed failure classes (one locator) → NOT app_defect", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [
      "Error: expect(received).toBe(expected)\nExpected: 'x'\nReceived: 'y'",
      "strict mode violation",
    ],
    failureClasses: ["value-mismatch", "locator"],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT);
});

test("R1: parity false — empty failureDetails → NOT app_defect", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [],
    failureClasses: [],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT);
});

test("R1: parity false — presence-matcher detail (C2/W3 guard) → NOT app_defect", () => {
  const detail =
    "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('row')\nReceived: <element(s) not found>\nTimeout: 5000ms\n - earlier: expect(locator).toHaveText('x')";
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [detail],
    failureClasses: ["locator"],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "presence-matcher failure must not be app_defect");
});

// R1: app_defect fires even when gateSpend=false (R1 takes precedence over R4)
test("R1 beats R4: no progress + clean app_defect → break-issue (not break-needs-human)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: [
      "Error: expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'",
    ],
    failureClasses: ["value-mismatch"],
    gateSpend: false, // gate closed, but R1 fires first
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

// ── R2 — generated_test_defect → continue ─────────────────────────────────────

test("R2: absent selector with spend still allowed → generated_test_defect/continue", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    absentKeysCount: 1,
    failureClasses: ["locator"],
    failureDetails: ["strict mode violation"],
    gateSpend: true,
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.GENERATED_TEST_DEFECT);
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

test("R2: all locator class with spend=true → generated_test_defect/continue", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureClasses: ["locator", "locator"],
    failureDetails: ["element not found", "waiting for locator"],
    gateSpend: true,
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.GENERATED_TEST_DEFECT);
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

test("R2: no further retry when gate is closed (spend=false) → NOT continue (R4 fires)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    absentKeysCount: 1,
    failureClasses: ["locator"],
    failureDetails: ["element not found"],
    gateSpend: false, // gate closed → R4 wins
  };
  const v = adjudicate(ev);
  assert.notEqual(v.action, ADJ_ACTION.CONTINUE, "gate is closed — must not continue");
});

// ── R3 — infra classes never open a repo Issue ────────────────────────────────

test("R3: devHealthy=false → dev_infra/break-issue", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: false,
    failureDetails: ["some error"],
    failureClasses: ["other"],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.DEV_INFRA);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

test("R3: all failureDetails match PLAYWRIGHT_INFRA_RE → runner_infra/break-issue", () => {
  const infraDetail = "browserType.launch: Executable doesn't exist at path";
  assert.ok(PLAYWRIGHT_INFRA_RE.test(infraDetail), "test sanity: infraDetail must match PLAYWRIGHT_INFRA_RE");
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: true,
    failureDetails: [infraDetail],
    failureClasses: ["other"],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.RUNNER_INFRA);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

test("R3: mixed failures (one infra, one real) → NOT runner_infra (conservative)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: true,
    failureDetails: [
      "browserType.launch: Executable doesn't exist at path",
      "Error: expect(received).toBe(expected)\nExpected: 'x'\nReceived: 'y'",
    ],
    failureClasses: ["other", "value-mismatch"],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.RUNNER_INFRA);
});

test("R3: runner_infra fires on empty failureDetails? No — no details means no runner_infra", () => {
  // runner_infra requires failureDetails.length > 0 (mirrors allFailuresAreRunnerInfra)
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: true,
    failureDetails: [],
    failureClasses: [],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.RUNNER_INFRA);
});

// ── R4 — asymmetric safety stop (break-needs-human) ───────────────────────────

test("R4: no progress + locator failure → break-needs-human", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["strict mode violation"],
    failureClasses: ["locator"],
    gateSpend: false,
  };
  const v = adjudicate(ev);
  assert.equal(v.action, ADJ_ACTION.BREAK_NEEDS_HUMAN);
});

test("R4: no progress + mixed/other failure → break-needs-human", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["some weird error", "another weird error"],
    failureClasses: ["other", "other"],
    gateSpend: false,
  };
  const v = adjudicate(ev);
  assert.equal(v.action, ADJ_ACTION.BREAK_NEEDS_HUMAN);
});

// ── R5 — objective_gap is observability-only ──────────────────────────────────

test("R5: objective_gap never blocks — action stays continue", () => {
  // Construct evidence that would trigger objective_gap: diff mode, non-empty objectiveSource,
  // all failing files defined, zero basename overlap, gateSpend=true
  const ev: AdjudicatorEvidence = {
    ...base(),
    mode: "diff",
    objectiveSource: ["src/auth/login.ts"],
    failingFiles: ["e2e/contact.spec.ts"],
    gateSpend: true,
    failureDetails: ["some error"],
    failureClasses: ["other"],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.action, ADJ_ACTION.BREAK_ISSUE, "objective_gap must not break-issue");
  assert.notEqual(v.action, ADJ_ACTION.BREAK_NEEDS_HUMAN, "objective_gap must not break-needs-human");
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

test("R5: objective_gap sets low confidence", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    mode: "diff",
    objectiveSource: ["src/auth/login.ts"],
    failingFiles: ["e2e/contact.spec.ts"],
    gateSpend: true,
    failureDetails: ["some error"],
    failureClasses: ["other"],
  };
  const v = adjudicate(ev);
  // If it classifies as objective_gap, confidence must be low
  if (v.class === ADJ_CLASS.OBJECTIVE_GAP) {
    assert.equal(v.confidence, ADJ_CONFIDENCE.LOW);
  }
  // Either way, action must be continue
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

// ── R6 — purity (identical inputs → identical output) ─────────────────────────

test("R6: determinism — two calls with same evidence produce deepStrictEqual output", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: ["Error: expect(received).toBe(expected)\nExpected: 'A'\nReceived: 'B'"],
    failureClasses: ["value-mismatch"],
    gateSpend: true,
  };
  const v1 = adjudicate(ev);
  const v2 = adjudicate(ev);
  assert.deepStrictEqual(v1, v2, "adjudicate must be deterministic");
});

test("R6: purity — function never throws on any valid input", () => {
  const evidences: AdjudicatorEvidence[] = [
    base(),
    { ...base(), devHealthy: false },
    { ...base(), allUnique: true, failureDetails: ["expect(x).toBe(y)\nExpected: 'a'\nReceived: 'b'"], failureClasses: ["value-mismatch"] },
    { ...base(), gateSpend: false, failureDetails: ["error"], failureClasses: ["other"] },
    { ...base(), isCode: true, failureDetails: ["some code error"], failureClasses: ["other"] },
  ];
  for (const ev of evidences) {
    try {
      const v = adjudicate(ev);
      assert.ok(v, "must return a verdict");
      assert.ok(v.class, "verdict.class must be set");
      assert.ok(v.action, "verdict.action must be set");
      assert.ok(v.confidence, "verdict.confidence must be set");
    } catch (err) {
      assert.fail(`adjudicate threw on evidence ${JSON.stringify(ev)}: ${err}`);
    }
  }
});

// ── Code mode: infra rules still fire (isCode doesn't override infra) ─────────

test("code mode: app_defect does NOT fire (isCode=true skips rule 2)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    isCode: true,
    allUnique: true,
    failureDetails: ["Error: expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'"],
    failureClasses: ["value-mismatch"],
    gateSpend: true,
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "isCode=true must skip app_defect rule");
});

// ── T6 (RED tests for T7 — Rule 2.5: 5xx → app_defect) ───────────────────────
// These tests must FAIL before T7 lands (Rule 2.5 does not yet exist) and pass after.

test("T6/S2.1: 5xx on a failing case → app_defect/high/break-issue (closes #681)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    failureDetails: ["Error: expect(locator).toBeVisible() failed — timed out"],
    failureClasses: ["locator"],
    devHealthy: true,
    httpStatuses: [500],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, "a 5xx must route to app_defect (closes #681)");
  assert.equal(v.confidence, ADJ_CONFIDENCE.HIGH);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
  // The reason must include the integer status for observability.
  assert.match(v.reason, /500/, "the reason must include the 5xx status integer");
});

test("T6/S2.2: 5xx during runner-infra → runner_infra still wins (Rule 1 beats Rule 2.5)", () => {
  const infraDetail = "browserType.launch: Executable doesn't exist at path";
  assert.ok(PLAYWRIGHT_INFRA_RE.test(infraDetail), "test sanity: infraDetail must match PLAYWRIGHT_INFRA_RE");
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: true,
    failureDetails: [infraDetail],
    failureClasses: ["other"],
    httpStatuses: [503],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.RUNNER_INFRA, "Rule 1 (runner_infra) must win over Rule 2.5 (5xx)");
});

test("T6/S2.3: 5xx during DEV unhealthy → dev_infra still wins (Rule 2 beats Rule 2.5)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: false,
    failureDetails: ["some error"],
    failureClasses: ["other"],
    httpStatuses: [502],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.DEV_INFRA, "Rule 2 (dev_infra) must win over Rule 2.5 (5xx-app_defect)");
});

test("T6/S2.4: value-mismatch with no 5xx → isLikelyRealBug path unchanged (Rule 3 intact)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: ["Error: expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'"],
    failureClasses: ["value-mismatch"],
    httpStatuses: [], // no 5xx
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, "value-mismatch via isLikelyRealBug must still fire");
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
  // Must NOT mention a 5xx status in the reason (Rule 3 path, not Rule 2.5).
  assert.doesNotMatch(v.reason, /backend returned a 5xx/, "must use the isLikelyRealBug path reason, not the 5xx path");
});

test("T6/S2.5: 4xx does NOT trigger app_defect — verdict unchanged from today", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["Error: expect(locator).toBeVisible() failed"],
    failureClasses: ["locator"],
    gateSpend: true,
    httpStatuses: [404], // 4xx — must NOT fire Rule 2.5
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "4xx must NOT trigger Rule 2.5 (5xx only)");
  // Must be the same verdict as without any httpStatus (locator + gateSpend → continue)
  assert.equal(v.class, ADJ_CLASS.GENERATED_TEST_DEFECT);
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

test("T6/S2.6: absent httpStatuses (undefined per case) → verdict unchanged from today", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["Error: strict mode violation"],
    failureClasses: ["locator"],
    absentKeysCount: 1,
    gateSpend: true,
    httpStatuses: [undefined], // absent for the case (not a 5xx)
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.GENERATED_TEST_DEFECT);
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "undefined httpStatus must NOT trigger Rule 2.5");
});

// MUST-FIX-3 mixed-run case (a): pure-locator-defect + background-500 → D2 dropped it → NOT app_defect
// D2 drops the background 500 at capture time, so the adjudicator sees httpStatuses: [] (no 5xx).
// The adjudicator's job is to handle this correctly without needing to know WHY the status is absent.
test("T6/D3-mixed-a: pure locator-defect + background-500 that D2 dropped → httpStatuses absent → NOT app_defect (false-attribution close)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["Error: strict mode violation — multiple elements found"],
    failureClasses: ["locator"],
    absentKeysCount: 0,
    gateSpend: true,
    httpStatuses: [], // D2 dropped the background ping/beacon/cross-origin 500 → no 5xx reaches adjudicator
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "a background 500 dropped by D2 must NOT produce app_defect — the adjudicator sees no httpStatus");
  assert.equal(v.action, ADJ_ACTION.CONTINUE, "a pure locator defect with no attributed 5xx must continue the fix-loop");
});

// MUST-FIX-3 mixed-run case (b): genuine correlated-5xx case + co-failing locator-defect → app_defect
// The genuine 5xx was attributed by D2 (same-origin, foreground), so httpStatuses carries it.
// The adjudicator routes the whole run to app_defect (deliberate .some choice — Rule 2.5).
// The co-failing locator case is NOT lost — it appears in the failed-case list.
test("T6/D3-mixed-b: genuine correlated-5xx + co-failing locator-defect → app_defect (deliberate .some choice)", () => {
  // Two failed cases: one with a genuine 5xx (correlated, assigned by D2), one with only a locator defect.
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: [
      "Error: expect(locator).toHaveText() failed — Expected: 'Welcome', Received: ''",
      "Error: strict mode violation — multiple elements found",
    ],
    failureClasses: ["locator", "locator"],
    gateSpend: true,
    httpStatuses: [500, undefined], // first case: genuine 5xx; second case: locator-only, no 5xx
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, "ONE genuine 5xx routes the whole run to app_defect (deliberate .some)");
  assert.equal(v.confidence, ADJ_CONFIDENCE.HIGH);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
  assert.match(v.reason, /500/, "the reason must include the 5xx status for the human triager");
});

// ── Feature B: classifyRuntimeErrors — pure classifier ────────────────────────
// Project-agnostic: only strong framework/uncaught signals set appDefect=true. Conservative —
// benign resource-load noise (401/403/404, warnings, favicon) must NEVER set appDefect.

test("classifyRuntimeErrors: a pageerror (uncaught JS exception) → appDefect=true", () => {
  const result = classifyRuntimeErrors([{ type: "pageerror", text: "TypeError: Cannot read properties of undefined (reading 'foo')" }]);
  assert.equal(result.appDefect, true, "any pageerror is an uncaught exception → appDefect");
  assert.ok(result.reasons.length > 0, "reasons must explain why appDefect fired");
});

test("classifyRuntimeErrors: Angular NG0100-style error code in console.error → appDefect=true", () => {
  const result = classifyRuntimeErrors([{ type: "error", text: "ERROR Error: NG0100: ExpressionChangedAfterItHasBeenCheckedError" }]);
  assert.equal(result.appDefect, true, "an NG#### Angular error code is a framework-error signature");
});

test("classifyRuntimeErrors: Angular zone 'ERROR Error:' prefix → appDefect=true", () => {
  const result = classifyRuntimeErrors([{ type: "error", text: "ERROR Error: Uncaught (in promise): Icon shopping-cart could not be found" }]);
  assert.equal(result.appDefect, true, "the Angular zone 'ERROR Error:' prefix is a framework-error signature");
});

test("classifyRuntimeErrors: 'Unhandled Promise rejection' → appDefect=true", () => {
  const result = classifyRuntimeErrors([{ type: "error", text: "Unhandled Promise rejection: NetworkError" }]);
  assert.equal(result.appDefect, true);
});

test("classifyRuntimeErrors: a lone 401 'Failed to load resource' → appDefect=false (benign noise)", () => {
  const result = classifyRuntimeErrors([{ type: "error", text: "Failed to load resource: the server responded with a status of 401 ()" }]);
  assert.equal(result.appDefect, false, "a resource-load failure is benign noise, not a framework error");
  assert.equal(result.reasons.length, 0);
});

test("classifyRuntimeErrors: a lone 403/404 'Failed to load resource' → appDefect=false (benign noise)", () => {
  const r403 = classifyRuntimeErrors([{ type: "error", text: "Failed to load resource: the server responded with a status of 403 (Forbidden)" }]);
  const r404 = classifyRuntimeErrors([{ type: "error", text: "Failed to load resource: the server responded with a status of 404 (Not Found)" }]);
  assert.equal(r403.appDefect, false);
  assert.equal(r404.appDefect, false);
});

test("classifyRuntimeErrors: favicon 404 + generic network failure → appDefect=false", () => {
  const result = classifyRuntimeErrors([
    { type: "error", text: "GET http://localhost/favicon.ico 404 (Not Found)" },
    { type: "error", text: "Failed to load resource: net::ERR_CONNECTION_REFUSED" },
  ]);
  assert.equal(result.appDefect, false, "favicon/network-load noise must never set appDefect");
});

test("classifyRuntimeErrors: a warning-level console entry → appDefect=false", () => {
  const result = classifyRuntimeErrors([{ type: "warning", text: "Deprecation warning: some API is deprecated" }]);
  assert.equal(result.appDefect, false, "warnings are not framework errors");
});

test("classifyRuntimeErrors: empty input → appDefect=false, reasons=[]", () => {
  const result = classifyRuntimeErrors([]);
  assert.equal(result.appDefect, false);
  assert.deepEqual(result.reasons, []);
});

test("classifyRuntimeErrors: a mix of benign noise + ONE framework error → appDefect=true", () => {
  const result = classifyRuntimeErrors([
    { type: "error", text: "Failed to load resource: the server responded with a status of 404 (Not Found)" },
    { type: "error", text: "GET http://localhost/favicon.ico 404 (Not Found)" },
    { type: "error", text: "ERROR Error: NG0303: Can't bind to 'ngModel'" },
  ]);
  assert.equal(result.appDefect, true, "one genuine framework error among benign noise must still set appDefect");
});

test("classifyRuntimeErrors: a bare 'Error:' console string (no uncaught/framework signature) → appDefect=false", () => {
  // Safe-direction (cardinal): a bare `console.error("Error: ...")` string is NOT a reliable app-defect
  // signal — apps routinely log HANDLED errors this way. Matching it would let benign logging mask a
  // real generated-test defect (Rule 2.6 routes ANY appDefect case straight to app_defect→Issue). A
  // GENUINELY uncaught error (React or otherwise) arrives as a `pageerror` and IS caught (see the
  // pageerror test above); a boundary-caught / merely-logged "Error:" is a deliberate false-negative.
  const result = classifyRuntimeErrors([{ type: "error", text: "Error: Objects are not valid as a React child (found: object with keys {a, b})" }]);
  assert.equal(result.appDefect, false, "a bare logged 'Error:' string is benign logging, not a framework/uncaught signal");
});

test("classifyRuntimeErrors: a handled app 'Error:' log on a failing run → appDefect=false (no masking)", () => {
  // The masking guard: a failing test (a real generated-test defect) whose page merely logged a
  // handled error must NOT be misclassified as an app defect and steal the Issue from the real cause.
  const result = classifyRuntimeErrors([{ type: "error", text: "Error: could not initialize the recommendations widget (using cached data)" }]);
  assert.equal(result.appDefect, false);
  assert.equal(result.reasons.length, 0);
});

test("classifyRuntimeErrors: 'Uncaught' console text (non-pageerror) → appDefect=true", () => {
  const result = classifyRuntimeErrors([{ type: "error", text: "Uncaught TypeError: x is not a function" }]);
  assert.equal(result.appDefect, true);
});

// ── Feature B: adjudicator Rule 2.6 — runtime errors → app_defect ─────────────
// Sits BELOW runner_infra/dev_infra/the 5xx rule (Rule 2.5) and ABOVE isLikelyRealBug (Rule 3):
// a framework-level runtime error is high-confidence app evidence even without a value-mismatch
// failure detail — this is the whole point of Feature B (jhipster's FontAwesome NG error broke
// the app silently; the E2E failure detail was a plain selector-count timeout, no value mismatch).

test("Rule 2.6: a pageerror on a failing case → app_defect/high/break-issue", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["Error: expect(fields).toHaveCount(4) failed\nReceived: 0"],
    failureClasses: ["value-mismatch"],
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: Cannot read properties of undefined" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, "a pageerror must route the failure to app_defect");
  assert.equal(v.confidence, ADJ_CONFIDENCE.HIGH);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

test("Rule 2.6: an Angular framework console.error on a failing case → app_defect", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    failureDetails: ["Error: expect(locator).toBeVisible() failed — timed out"],
    failureClasses: ["locator"],
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "error", text: "ERROR Error: Icon shopping-cart could not be found" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT);
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
  assert.match(v.reason, /runtime error/i, "the reason must mention the runtime-error evidence");
});

test("Rule 2.6: benign console noise only (no framework signature) → does NOT force app_defect", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: false,
    failureDetails: ["Error: expect(locator).toBeVisible() failed"],
    failureClasses: ["locator"],
    absentKeysCount: 1,
    gateSpend: true,
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "error", text: "Failed to load resource: the server responded with a status of 401 ()" }]],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "benign resource-load noise must never force app_defect");
  assert.equal(v.class, ADJ_CLASS.GENERATED_TEST_DEFECT);
  assert.equal(v.action, ADJ_ACTION.CONTINUE);
});

test("Rule 2.6: empty runtimeErrorsByCase (capture disabled/missed) → verdict unchanged from today", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    allUnique: true,
    failureDetails: ["Error: expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'"],
    failureClasses: ["value-mismatch"],
    httpStatuses: [],
    runtimeErrorsByCase: [],
  };
  const v = adjudicate(ev);
  // isLikelyRealBug (Rule 3) still fires on its own merits — Rule 2.6 must be a strict no-op here.
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT);
  assert.doesNotMatch(v.reason, /runtime error/i, "must take the isLikelyRealBug path, not the runtime-error path");
});

test("Rule 2.6: runner_infra still wins over a co-present runtime error (Rule 1 beats Rule 2.6)", () => {
  const infraDetail = "browserType.launch: Executable doesn't exist at path";
  const ev: AdjudicatorEvidence = {
    ...base(),
    failureDetails: [infraDetail],
    failureClasses: ["other"],
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: boom" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.RUNNER_INFRA, "Rule 1 (runner_infra) must win over Rule 2.6");
});

test("Rule 2.6: dev_infra still wins over a co-present runtime error (Rule 2 beats Rule 2.6)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    devHealthy: false,
    failureDetails: ["some error"],
    failureClasses: ["other"],
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: boom" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.DEV_INFRA, "Rule 2 (dev_infra) must win over Rule 2.6");
});

test("Rule 2.6: the 5xx rule (2.5) still wins/co-fires over a runtime error — reason mentions the 5xx path", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    failureDetails: ["Error: expect(locator).toBeVisible() failed"],
    failureClasses: ["locator"],
    httpStatuses: [500],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: boom" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT);
  assert.match(v.reason, /5xx|backend returned/i, "Rule 2.5 (5xx) precedes Rule 2.6 — reason must reflect the 5xx path");
});

test("Rule 2.6: mixed cases — one clean case + one runtime-error case → app_defect (deliberate .some choice, mirrors Rule 2.5)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    failureDetails: [
      "Error: expect(locator).toHaveText() failed — Expected: 'Welcome', Received: ''",
      "Error: expect(fields).toHaveCount(4) failed\nReceived: 0",
    ],
    failureClasses: ["locator", "value-mismatch"],
    httpStatuses: [],
    runtimeErrorsByCase: [[], [{ type: "pageerror", text: "TypeError: boom" }]],
  };
  const v = adjudicate(ev);
  assert.equal(v.class, ADJ_CLASS.APP_DEFECT, "ONE case with a genuine runtime error routes the whole run to app_defect");
  assert.equal(v.action, ADJ_ACTION.BREAK_ISSUE);
});

test("Rule 2.6: never fires in code mode (isCode=true skips runtime-error evidence entirely)", () => {
  const ev: AdjudicatorEvidence = {
    ...base(),
    isCode: true,
    failureDetails: ["some test failure"],
    failureClasses: ["other"],
    httpStatuses: [],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: boom" }]],
  };
  const v = adjudicate(ev);
  assert.notEqual(v.class, ADJ_CLASS.APP_DEFECT, "code mode has no browser — runtime errors must never apply");
});

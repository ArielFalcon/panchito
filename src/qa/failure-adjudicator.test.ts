import { test } from "node:test";
import assert from "node:assert/strict";

// RED phase (tasks 1.1 + 1.2): these tests are written BEFORE the module exists.
// They drive the implementation of failure-adjudicator.ts.
import {
  adjudicate,
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

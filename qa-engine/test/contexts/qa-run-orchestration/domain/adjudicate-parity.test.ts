import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: pins the re-ported adjudicate() (Task D.4) against the REAL legacy original it ports —
// src/qa/failure-adjudicator.ts, NOT qa-engine's test-execution/domain/adjudicate.service.ts (that
// file's AdjudicateService.adjudicate(verdict, cases) is a DIFFERENT, unrelated helper — a narrow
// runner-infra reclassification already parity-pinned by its own adjudicate-parity.test.ts under
// test-execution). This file imports src/qa/failure-adjudicator.ts, so it is added to the qa-engine
// typecheck "exclude" list (parity-import pattern, same as legacy-pipeline.adapter.test.ts /
// derive-cycle-backstop-parity.test.ts).
import {
  adjudicate,
  type AdjudicatorEvidence,
} from "@contexts/qa-run-orchestration/domain/adjudicate.service.ts";
import { adjudicate as legacy } from "../../../../../src/qa/failure-adjudicator.ts";

function baseEvidence(overrides: Partial<AdjudicatorEvidence> = {}): AdjudicatorEvidence {
  return {
    isCode: false,
    allUnique: false,
    failureDetails: ["locator not found"],
    failureClasses: ["locator"],
    absentKeysCount: 0,
    gateSpend: true,
    gateReason: "first retry — baseline established",
    devHealthy: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    failingFiles: ["checkout.spec.ts"],
    httpStatuses: [undefined],
    runtimeErrorsByCase: [[]],
    ...overrides,
  };
}

test("PARITY: adjudicate matches legacy — runner_infra (Rule 1)", () => {
  const ev = baseEvidence({
    failureDetails: ["browserType.launch: Executable doesn't exist"],
    failureClasses: ["other"],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — dev_infra (Rule 2)", () => {
  const ev = baseEvidence({ devHealthy: false });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — app_defect via 5xx (Rule 2.5)", () => {
  const ev = baseEvidence({ httpStatuses: [500] });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — app_defect via runtime error (Rule 2.6)", () => {
  const ev = baseEvidence({
    runtimeErrorsByCase: [[{ type: "pageerror", text: "Uncaught TypeError: x is not a function" }]],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — app_defect via isLikelyRealBug (Rule 3)", () => {
  const ev = baseEvidence({
    allUnique: true,
    failureDetails: ["expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'"],
    failureClasses: ["value-mismatch"],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — generated_test_defect/continue via absent selector (Rule 4)", () => {
  const ev = baseEvidence({ absentKeysCount: 1 });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — generated_test_defect/continue via all-locator class (Rule 4)", () => {
  const ev = baseEvidence({ failureClasses: ["locator", "locator"] });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — break-needs-human when gate closed (Rule 5)", () => {
  const ev = baseEvidence({ gateSpend: false, gateReason: "no progress — agent ignored ground truth" });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — objective_gap label (Rule 6, inert)", () => {
  const ev = baseEvidence({
    absentKeysCount: 0,
    failureClasses: ["other"],
    failureDetails: ["some ambiguous failure"],
    failingFiles: ["unrelated.spec.ts"],
    objectiveSource: ["src/checkout.ts"],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — default fallthrough (ambiguous, low, continue)", () => {
  const ev = baseEvidence({
    absentKeysCount: 0,
    failureClasses: ["other"],
    failureDetails: ["some ambiguous failure"],
    objectiveSource: [],
    failingFiles: [],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — code mode skips app_defect/objective_gap rules", () => {
  const ev = baseEvidence({
    isCode: true,
    allUnique: true,
    failureDetails: ["exit code 1"],
    failureClasses: ["other"],
    httpStatuses: [500],
    runtimeErrorsByCase: [[{ type: "pageerror", text: "Uncaught" }]],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — mixed failures (one infra, one real) NOT runner_infra (conservative)", () => {
  const ev = baseEvidence({
    failureDetails: ["browserType.launch: Executable doesn't exist", "locator not found"],
    failureClasses: ["other", "locator"],
  });
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

test("PARITY: adjudicate matches legacy — determinism (same evidence, two calls, deep-equal)", () => {
  const ev = baseEvidence();
  assert.deepEqual(adjudicate(ev), adjudicate(ev));
  assert.deepEqual(adjudicate(ev), legacy(ev));
});

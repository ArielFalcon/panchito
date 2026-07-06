import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDistillLearning } from "@contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts";

// The gating predicate across its input space (isCode × every RunVerdict). Suppress distillation
// ONLY for isCode + fail (the agent's generated test correctly caught a real bug — distilling a
// "fix this test" rule would teach the engine to weaken a test that did its job).

test("shouldDistillLearning: isCode=true, verdict=fail — suppressed (the ONE exception)", () => {
  assert.equal(shouldDistillLearning(true, "fail"), false);
});

test("shouldDistillLearning: isCode=true, verdict=invalid — still feeds learning (broken generated tests)", () => {
  assert.equal(shouldDistillLearning(true, "invalid"), true);
});

test("shouldDistillLearning: isCode=true, verdict=pass — feeds learning", () => {
  assert.equal(shouldDistillLearning(true, "pass"), true);
});

test("shouldDistillLearning: isCode=true, verdict=flaky — feeds learning", () => {
  assert.equal(shouldDistillLearning(true, "flaky"), true);
});

test("shouldDistillLearning: isCode=true, verdict=infra-error — feeds learning", () => {
  assert.equal(shouldDistillLearning(true, "infra-error"), true);
});

test("shouldDistillLearning: isCode=true, verdict=skipped — feeds learning", () => {
  assert.equal(shouldDistillLearning(true, "skipped"), true);
});

test("shouldDistillLearning: isCode=false (e2e), verdict=fail — unaffected, still feeds learning", () => {
  assert.equal(shouldDistillLearning(false, "fail"), true);
});

test("shouldDistillLearning: isCode=false (e2e), verdict=pass — feeds learning", () => {
  assert.equal(shouldDistillLearning(false, "pass"), true);
});

// post-cutover-remediation P3 (unit 4): a THIRD, optional arg — the FixLoop's own adjudicator
// verdict class. Suppress distillation when the adjudicator attributed the failure to the APP
// (app_defect) — distilling a "fix this test" rule for a test that correctly caught a real app bug
// would teach the engine to weaken a test that did its job (the same Goodhart concern the existing
// isCode+fail rule guards against, now extended to the adjudicator's OWN classification). This is an
// INDEPENDENT guard clause, layered ON TOP of (not replacing) the existing isCode+fail rule — the
// two conditions AND together (`!(isCode && fail) && adjudicationClass !== "app_defect"`).

test("shouldDistillLearning: adjudicationClass=app_defect — suppressed regardless of isCode/verdict", () => {
  assert.equal(shouldDistillLearning(false, "fail", "app_defect"), false);
});

test("shouldDistillLearning: adjudicationClass=generated_test_defect — still feeds learning (not app_defect)", () => {
  assert.equal(shouldDistillLearning(false, "fail", "generated_test_defect"), true);
});

test("shouldDistillLearning: adjudicationClass=undefined — unchanged (3rd arg omitted, isCode=true+fail still suppressed)", () => {
  assert.equal(shouldDistillLearning(true, "fail", undefined), false);
});

test("shouldDistillLearning: verdict=pass, adjudicationClass=undefined — feeds learning (3rd arg omitted, backward compatible)", () => {
  assert.equal(shouldDistillLearning(false, "pass", undefined), true);
});

test("shouldDistillLearning: adjudicationClass=runner_infra — does NOT suppress on its own (guard is keyed ONLY on app_defect)", () => {
  assert.equal(shouldDistillLearning(false, "fail", "runner_infra"), true);
});

test("shouldDistillLearning: adjudicationClass=dev_infra — does NOT suppress on its own", () => {
  assert.equal(shouldDistillLearning(false, "fail", "dev_infra"), true);
});

test("shouldDistillLearning: adjudicationClass=objective_gap — does NOT suppress on its own", () => {
  assert.equal(shouldDistillLearning(false, "fail", "objective_gap"), true);
});

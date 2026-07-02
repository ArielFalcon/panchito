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

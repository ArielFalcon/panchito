import { test } from "node:test";
import assert from "node:assert/strict";
import { RunDecision } from "@contexts/qa-run-orchestration/domain/run-decision.ts";

// The RunDecision VO (Task D.3): the outcome of RunDecisionService.decide() — a verdict paired
// with the side effect it triggers. Immutable, carries both fields together so a caller can never
// observe a verdict without its matching side effect (the two are decided as one unit, exactly
// like the legacy scattered branches always paired a verdict assignment with a report()/publish
// call at the same site).

test("RunDecision: carries both verdict and sideEffect", () => {
  const decision = RunDecision.of("pass", "pr");
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "pr");
});

test("RunDecision: is immutable — fields are readonly (TypeScript-enforced, runtime object stays frozen)", () => {
  const decision = RunDecision.of("fail", "issue");
  assert.throws(() => {
    // @ts-expect-error — verdict is readonly; this line exists to prove the runtime guard too.
    decision.verdict = "pass";
  });
});

test("RunDecision: accepts every RunVerdict value", () => {
  const verdicts = ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"] as const;
  for (const v of verdicts) {
    const decision = RunDecision.of(v, "none");
    assert.equal(decision.verdict, v);
  }
});

test("RunDecision: accepts every SideEffect value, including quarantine", () => {
  const effects = ["pr", "issue", "shadow-log", "quarantine", "none"] as const;
  for (const e of effects) {
    const decision = RunDecision.of("pass", e);
    assert.equal(decision.sideEffect, e);
  }
});

test("RunDecision: two instances with the same verdict+sideEffect are structurally equal (value semantics)", () => {
  const a = RunDecision.of("flaky", "quarantine");
  const b = RunDecision.of("flaky", "quarantine");
  assert.deepEqual(a, b);
});

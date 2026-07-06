// PARITY: the ported fold math must match legacy src/qa/learning/learning-rule.ts byte-for-byte
// behavior (running-mean successRate, hysteresis-gated status transitions, coverage-anchor gate,
// prevention scoring) until the legacy module is deleted. Imports from src/ (outside qa-engine
// rootDir) — excluded from qa-engine typecheck (see qa-engine/tsconfig.json), runs via tsx at
// runtime, typechecked only under qa-engine/tsconfig.parity.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOutcome,
  deriveConfidence,
  preventionOutcome,
  attributableRules,
  PREVENTION_HELD_SCORE,
} from "@contexts/cross-run-learning/domain/rule-fold.ts";
import {
  applyOutcome as legacyApplyOutcome,
  deriveConfidence as legacyDeriveConfidence,
  preventionOutcome as legacyPreventionOutcome,
  attributableRules as legacyAttributableRules,
  PREVENTION_HELD_SCORE as LEGACY_PREVENTION_HELD_SCORE,
} from "../../../../../src/qa/learning/learning-rule.ts";
import type { LearningRule as LegacyLearningRule } from "../../../../../src/qa/learning/learning-rule.ts";

function makeRule(overrides: Partial<LegacyLearningRule> = {}): LegacyLearningRule {
  return {
    id: "lr-1",
    trigger: "fragile selector",
    action: "use getByRole",
    errorClass: "E-FRAGILE-SELECTOR",
    archetype: null,
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "distiller",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("PARITY: PREVENTION_HELD_SCORE constant matches legacy", () => {
  assert.equal(PREVENTION_HELD_SCORE, LEGACY_PREVENTION_HELD_SCORE);
});

test("PARITY: deriveConfidence matches legacy across the outcomeCount/successRate matrix", () => {
  const samples: Array<[number, number | null]> = [
    [0, null],
    [1, 0.9],
    [2, 0.9],
    [3, 0.9],
    [3, 0.6],
    [3, 0.5],
    [3, 0.44],
    [3, 0.2],
    [10, 0.7],
  ];
  for (const [outcomeCount, successRate] of samples) {
    assert.equal(
      deriveConfidence(outcomeCount, successRate),
      legacyDeriveConfidence(outcomeCount, successRate),
      JSON.stringify([outcomeCount, successRate]),
    );
  }
});

test("PARITY: preventionOutcome matches legacy across errorClass combinations", () => {
  const samples: Array<[string, string | null]> = [
    ["E-INFRA", "E-INFRA"],
    ["E-FLAKY", null],
    ["E-FRAGILE-SELECTOR", "E-FRAGILE-SELECTOR"],
    ["E-FRAGILE-SELECTOR", null],
    ["E-FRAGILE-SELECTOR", "E-EXEC-FAIL"],
  ];
  for (const [ruleClass, runClass] of samples) {
    assert.equal(
      preventionOutcome(ruleClass as never, runClass as never),
      legacyPreventionOutcome(ruleClass as never, runClass as never),
      JSON.stringify([ruleClass, runClass]),
    );
  }
});

test("PARITY: applyOutcome running-mean + hysteresis matches legacy across a transition sample table", () => {
  const scenarios: Array<{ rule: Partial<LegacyLearningRule>; score: number; coverageCreditConfirmed: boolean | null }> = [
    { rule: { status: "candidate", outcomeCount: 0, successRate: null }, score: 0.8, coverageCreditConfirmed: null },
    { rule: { status: "candidate", outcomeCount: 2, successRate: 0.5 }, score: 0.9, coverageCreditConfirmed: true },
    { rule: { status: "candidate", outcomeCount: 2, successRate: 0.9 }, score: 0.9, coverageCreditConfirmed: false },
    { rule: { status: "active", outcomeCount: 5, successRate: 0.5 }, score: 0.1, coverageCreditConfirmed: null },
    { rule: { status: "deprecated", outcomeCount: 5, successRate: 0.5 }, score: 0.9, coverageCreditConfirmed: null },
    { rule: { status: "pending", outcomeCount: 0, successRate: null }, score: 0.5, coverageCreditConfirmed: null },
  ];
  for (const s of scenarios) {
    const rule = makeRule(s.rule);
    const ported = applyOutcome(rule as never, s.score, s.coverageCreditConfirmed);
    const legacy = legacyApplyOutcome(rule, s.score, s.coverageCreditConfirmed);
    assert.deepEqual(ported, legacy, JSON.stringify(s));
  }
});

test("PARITY: attributableRules matches legacy fail-open filtering", () => {
  const rules: LegacyLearningRule[] = [
    makeRule({ id: "lr-a", archetype: "form" }),
    makeRule({ id: "lr-b", archetype: "api-call" }),
    makeRule({ id: "lr-c", archetype: null }),
  ];
  const ctxs = [{ diffArchetypes: [] as string[] }, { diffArchetypes: ["form"] }, { diffArchetypes: ["unrelated"] }];
  for (const ctx of ctxs) {
    const ported = attributableRules(rules as never, ctx);
    const legacy = legacyAttributableRules(rules, ctx);
    assert.deepEqual(ported, legacy, JSON.stringify(ctx));
  }
});

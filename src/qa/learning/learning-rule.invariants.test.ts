import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConfidence,
  applyOutcome,
  preventionOutcome,
  PREVENTION_HELD_SCORE,
  type LearningRule,
} from "./learning-rule";

// Invariant net for the learning ledger's governance. These pin the guarantees the whole
// value/trust story rests on, so a future tweak to a threshold (PROMOTE_RATE, DEMOTE_RATE,
// PREVENTION_HELD_SCORE, the deriveConfidence bands) that quietly breaks them fails loudly here
// instead of silently letting unproven rules earn trust they didn't earn.

function seedRule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "r",
    trigger: "Applies when x changes",
    action: "do y",
    errorClass: "E-FRAGILE-SELECTOR",
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "seed",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fold(rule: LearningRule, scores: number[]): LearningRule {
  return scores.reduce((r, s) => applyOutcome(r, s), rule);
}

describe("ledger invariant: high confidence ⟹ oracle ground-truth", () => {
  it("a rule fed ONLY prevention outcomes (0 | PREVENTION_HELD_SCORE) can never reach 'high'", () => {
    // The strongest prevention signal is PREVENTION_HELD_SCORE; the running mean of any sequence
    // drawn from {0, 0.6} stays ≤ 0.6, below the 0.7 'high' band. Exhaustive over sequence length.
    for (let n = 1; n <= 30; n++) {
      const allHeld = fold(seedRule(), Array(n).fill(PREVENTION_HELD_SCORE));
      assert.notEqual(allHeld.confidence, "high", `all-held n=${n} must never be 'high'`);
      assert.ok((allHeld.successRate ?? 0) <= PREVENTION_HELD_SCORE + 1e-9, `mean must stay ≤ ceiling at n=${n}`);
    }
    const mixed = fold(seedRule(), [0.6, 0, 0.6, 0.6, 0, 0.6, 0.6, 0.6, 0.6, 0.6]);
    assert.notEqual(mixed.confidence, "high");
  });

  it("PREVENTION_HELD_SCORE plateaus exactly at promote-to-active but caps at 'medium'", () => {
    const held = fold(seedRule(), Array(5).fill(PREVENTION_HELD_SCORE));
    assert.equal(held.status, "active", "consistent prevention earns promotion to active");
    assert.equal(held.confidence, "medium", "but never lifts past medium without the oracle");
  });

  it("an oracle-range signal (≥0.7) is what unlocks 'high'", () => {
    const oracleProven = fold(seedRule(), [1, 1, 1, 0.9]);
    assert.equal(oracleProven.confidence, "high");
    // The band boundary itself: 0.6 (prevention ceiling) is medium, 0.7 is high.
    assert.equal(deriveConfidence(5, 0.69), "medium");
    assert.equal(deriveConfidence(5, 0.7), "high");
  });
});

describe("ledger invariant: asymmetric hysteresis (slow to demote) + nothing is deleted", () => {
  it("no status change or confidence above 'low' before MIN_OUTCOMES", () => {
    const r = fold(seedRule(), [1, 1]); // 2 outcomes
    assert.equal(r.confidence, "low", "insufficient evidence stays low");
    assert.equal(r.status, "candidate", "insufficient evidence does not promote");
  });

  it("a single anomalous bad outcome does not demote a trusted active rule", () => {
    const active = fold(seedRule(), [1, 1, 1, 1]);
    assert.equal(active.status, "active");
    const afterOneBad = applyOutcome(active, 0);
    assert.equal(afterOneBad.status, "active", "one flaky 0 keeps the mean above DEMOTE_RATE");
  });

  it("sustained failure demotes active → deprecated (it is never removed)", () => {
    const active = fold(seedRule(), [1, 1, 1]);
    const demoted = fold(active, Array(12).fill(0));
    assert.equal(demoted.status, "deprecated");
  });

  it("a deprecated rule is reversible when outcomes recover", () => {
    const demoted = fold(fold(seedRule(), [1, 1, 1]), Array(12).fill(0));
    assert.equal(demoted.status, "deprecated");
    const recovered = fold(demoted, Array(30).fill(1));
    assert.equal(recovered.status, "active", "sustained good outcomes resurrect it");
  });

  it("promotion requires a clearly positive mean — a mean of 0.5 does NOT promote", () => {
    // Brackets the promotion bar from below: with the "prevention 0.6 → active" test above bounding
    // it from above (≤ 0.6), this pins PROMOTE_RATE in (0.5, 0.6] so a silent loosening is caught.
    const lukewarm = fold(seedRule(), [0.5, 0.5, 0.5]);
    assert.equal(lukewarm.status, "candidate", "a 0.5 mean is not enough evidence to promote");
  });

  it("'superseded' is terminal: outcomes never revive or further move it", () => {
    const sup = seedRule({ status: "superseded" });
    assert.equal(fold(sup, [1, 1, 1, 1, 1]).status, "superseded", "good outcomes cannot revive it");
    assert.equal(fold(sup, [0, 0, 0, 0, 0]).status, "superseded", "bad outcomes cannot move it");
  });
});

describe("preventionOutcome signal semantics", () => {
  it("own class = hard 0, clean run = capped positive, noise/unrelated = null (no evidence)", () => {
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-FRAGILE-SELECTOR"), 0);
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", null), PREVENTION_HELD_SCORE);
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-INFRA"), null);
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-FLAKY"), null);
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-COVERAGE-GAP"), null);
  });
});

describe("applyOutcome accumulates an arithmetic running mean (self-contained pin)", () => {
  it("successRate is the mean of all folded scores, not a windowed/last value", () => {
    assert.ok(Math.abs((fold(seedRule(), [1, 0]).successRate ?? -1) - 0.5) < 1e-9, "[1,0] → 0.5");
    assert.ok(Math.abs((fold(seedRule(), [1, 0, 0]).successRate ?? -1) - 1 / 3) < 1e-9, "[1,0,0] → 1/3");
    // A wrong denominator (e.g. windowing or overwriting) would drift these off the true mean.
  });
});

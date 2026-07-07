// qa-engine/test/contexts/cross-run-learning/domain/rule-fold.test.ts
// WS1.4(a) (full-flow remediation, INTERIM promotion-safety gate): the GOVERNANCE consequence of
// preventionOutcome's empty-errorClass guard, pinned at the fold level rather than only at the
// preventionOutcome unit level. The real caller (rewritten-engine-factory.ts's recordOutcome
// prevention path, forbidden-file — read-only reference here) only ever calls
// applyOutcome/recordRuleOutcome when preventionOutcome(...) returns non-null:
//
//   const score = preventionOutcome(rule.errorClass, errorClass);
//   if (score !== null) recordRuleOutcome(id, score, coverageCreditConfirmed);
//
// This test simulates that exact "score null -> no write" gate using ONLY this module's pure
// exports (preventionOutcome + applyOutcome), so it exercises the real governance shape without
// touching the forbidden factory file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { preventionOutcome, applyOutcome } from "@contexts/cross-run-learning/domain/rule-fold.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

function makeRule(overrides: Partial<LearningRule> = {}): LearningRule {
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

// Mirrors the real caller's gate: only fold when preventionOutcome returns non-null.
function foldPreventionOutcome(rule: LearningRule, runErrorClass: string | null): LearningRule {
  const score = preventionOutcome(rule.errorClass, runErrorClass);
  return score === null ? rule : applyOutcome(rule, score);
}

test("WS1.4(a): a rule with errorClass \"\" folded across three clean runs does NOT advance outcomeCount via the prevention path (unfalsifiable — no signal, no write)", () => {
  let rule = makeRule({ errorClass: "" as never, status: "candidate", outcomeCount: 0, successRate: null });

  for (let i = 0; i < 3; i++) {
    rule = foldPreventionOutcome(rule, null); // clean run, three times over
  }

  assert.equal(rule.outcomeCount, 0, "outcomeCount must stay at 0 — an unfalsifiable rule earns no prevention credit at all");
  assert.equal(rule.successRate, null, "successRate must stay unset — nothing was ever folded in");
  assert.equal(rule.status, "candidate", "status must NOT advance toward active — MIN_OUTCOMES (3) was never reached because nothing was ever recorded");
});

test("WS1.4(a) regression pin: a rule with a REAL errorClass still earns held credit (PREVENTION_HELD_SCORE) when its class did not recur, and promotes after MIN_OUTCOMES clean runs", () => {
  let rule = makeRule({ errorClass: "E-FRAGILE-SELECTOR", status: "candidate", outcomeCount: 0, successRate: null });

  for (let i = 0; i < 3; i++) {
    rule = foldPreventionOutcome(rule, null); // clean run, three times over — the rule "held"
  }

  assert.equal(rule.outcomeCount, 3, "a real-class rule DOES accrue prevention credit on clean runs — this is the designed, non-circular promotion signal");
  assert.equal(rule.successRate, 0.6, "held credit plateaus at PREVENTION_HELD_SCORE (0.6) — capped at medium confidence, never high");
  assert.equal(rule.status, "active", "three clean held runs promote a real-class candidate to active — unaffected by the empty-class guard");
  assert.equal(rule.confidence, "medium", "prevention-only promotion never reaches high confidence");
});

test("WS1.4(a): an empty-errorClass rule also earns no debit when its own (nonexistent) class 'recurs' — the unfalsifiable guard is symmetric, not just a held-credit block", () => {
  // Even if some caller passed runErrorClass === "" (never happens through the real taxonomy, but
  // defensively verified here), the empty-class guard fires FIRST — no signal in either direction.
  let rule = makeRule({ errorClass: "" as never, status: "candidate", outcomeCount: 0, successRate: null });
  rule = foldPreventionOutcome(rule, "" as never);
  assert.equal(rule.outcomeCount, 0, "no debit either — the guard is unconditional on the rule's own blank class");
});

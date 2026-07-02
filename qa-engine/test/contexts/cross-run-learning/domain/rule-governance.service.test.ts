import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleGovernanceService } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

// `at` is required: the full legacy LearningRule includes it (history.ts ORDER BY ... at DESC).
const rule = (status: LearningRule["status"], successRate: number | null, trigger: string, at = "2026-01-01T00:00:00.000Z"): LearningRule =>
  ({ id: trigger, trigger, action: "a", errorClass: "E-X", archetype: null, status, confidence: "medium", usageCount: 0, outcomeCount: 0, successRate, lastVerified: null, source: "oracle", at });

const svc = new RuleGovernanceService();

test("rank: active before candidate, then by successRate desc (the former SQL ORDER BY, now pure)", () => {
  const ranked = svc.rank([
    rule("candidate", 0.9, "c-high"),
    rule("active", 0.5, "a-low"),
    rule("active", 0.8, "a-high"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["a-high", "a-low", "c-high"]);
});

test("rank: a null successRate sorts as 0 (COALESCE(success_rate, 0))", () => {
  const ranked = svc.rank([rule("active", null, "a-null"), rule("active", 0.1, "a-0.1")]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["a-0.1", "a-null"]);
});

test("rank: at DESC tiebreak when status and successRate are identical (3rd SQL sort key)", () => {
  const ranked = svc.rank([
    rule("active", 0.5, "older", "2026-01-01T00:00:00.000Z"),
    rule("active", 0.5, "newer", "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(ranked.map((r) => r.trigger), ["newer", "older"]);
});

test("topRules: only active+candidate are retrievable, deprecated/superseded excluded", () => {
  const top = svc.topRules([rule("deprecated", 0.9, "dep"), rule("active", 0.5, "act"), rule("superseded", 0.9, "sup")], 5);
  assert.deepEqual(top.map((r) => r.trigger), ["act"]);
});

// ── W3 F3c (dual-judge round): the portable half of legacy's selectForRetrieval relevance bias
// (errorClass/archetype matching, +3 each) — optional, additive, subordinate to successRate. ──────

const ruleWithMeta = (
  status: LearningRule["status"], successRate: number | null, trigger: string,
  errorClass: string, archetype: string | null, at = "2026-01-01T00:00:00.000Z",
): LearningRule =>
  ({ id: trigger, trigger, action: "a", errorClass, archetype, status, confidence: "medium", usageCount: 0, outcomeCount: 0, successRate, lastVerified: null, source: "oracle", at });

test("topRules: without a relevance bias, behaves EXACTLY as before (pure SQL-ORDER-BY parity)", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "a", "E-X", null),
    ruleWithMeta("active", 0.5, "b", "E-Y", "form"),
  ];
  const top = svc.topRules(rules, 5); // no relevance opts
  // Tied on status+successRate -> falls through to `at` DESC; both share the same `at`, so
  // insertion-stable via the sort's own tie handling (localeCompare on identical strings = 0).
  assert.deepEqual(top.map((r) => r.trigger).sort(), ["a", "b"]);
});

test("topRules: an errorClass match biases a lower-successRate rule above a non-matching higher one", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "matches-error-class", "E-EXEC-FAIL", null),
    ruleWithMeta("active", 0.6, "no-match", "E-FLAKY", null),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL" });
  // matches-error-class: 0.5 + 3 = 3.5; no-match: 0.6 + 0 = 0.6 -> matches-error-class wins.
  assert.deepEqual(top.map((r) => r.trigger), ["matches-error-class", "no-match"]);
});

test("topRules: an archetype match biases a lower-successRate rule above a non-matching higher one", () => {
  const rules = [
    ruleWithMeta("active", 0.5, "matches-archetype", "E-X", "form"),
    ruleWithMeta("active", 0.6, "no-match", "E-X", "api-call"),
  ];
  const top = svc.topRules(rules, 5, { archetypes: ["form"] });
  assert.deepEqual(top.map((r) => r.trigger), ["matches-archetype", "no-match"]);
});

test("topRules: matching BOTH errorClass and archetype stacks the bias additively (+3 +3 = +6)", () => {
  const rules = [
    ruleWithMeta("active", 0.1, "double-match", "E-EXEC-FAIL", "form"),
    ruleWithMeta("active", 0.6, "single-match", "E-EXEC-FAIL", "api-call"),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL", archetypes: ["form"] });
  // double-match: 0.1 + 3 + 3 = 6.1; single-match: 0.6 + 3 = 3.6 -> double-match wins.
  assert.deepEqual(top.map((r) => r.trigger), ["double-match", "single-match"]);
});

test("topRules: relevance bias never overrides the status (active) priority — exploit still beats explore", () => {
  const rules = [
    ruleWithMeta("candidate", 0.9, "candidate-relevant", "E-EXEC-FAIL", "form"),
    ruleWithMeta("active", 0.1, "active-irrelevant", "E-Y", null),
  ];
  const top = svc.topRules(rules, 5, { errorClass: "E-EXEC-FAIL", archetypes: ["form"] });
  assert.deepEqual(top.map((r) => r.trigger), ["active-irrelevant", "candidate-relevant"], "status is a separate, higher-priority sort key — bias only breaks ties within the same status");
});

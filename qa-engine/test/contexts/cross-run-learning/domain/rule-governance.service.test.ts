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

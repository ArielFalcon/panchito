// test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts";
import { Sha } from "@kernel/sha.ts";

// A legacy row with status 'pending' (an older build wrote it). The read path MUST coerce it.
// Column names mirror the real `learning_rules` schema: trigger_text, action_text, error_class,
// plus the full set of fields rowToRule maps (id, archetype, usage_count, outcome_count,
// last_verified, source, at).
const rows = [
  { id: "r1", trigger_text: "t1", action_text: "a1", error_class: "E-X", archetype: null, status: "pending", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.9, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" },
  { id: "r2", trigger_text: "t2", action_text: "a2", error_class: "E-Y", archetype: null, status: "active", confidence: "high", usage_count: 2, outcome_count: 5, success_rate: 0.5, last_verified: null, source: "oracle", at: "2026-01-02T00:00:00.000Z" },
];

test("maps a legacy 'pending' row to 'candidate' before typing (§11 back-compat)", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, recordOutcome: () => {} });
  const top = await repo.topRules(Sha.of("abcdef1"), 10);
  const t1 = top.find((r) => r.trigger === "t1");
  assert.ok(t1, "the pending row must survive as a candidate, not be dropped");
  assert.equal(t1!.status, "candidate"); // coerced from 'pending'
});

test("topRules ranks via RuleGovernanceService — active before the coerced candidate", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, recordOutcome: () => {} });
  const top = await repo.topRules(Sha.of("abcdef1"), 10);
  assert.deepEqual(top.map((r) => r.trigger), ["t2", "t1"]); // active(0.5) before candidate(0.9)
});

test("save delegates to the injected upsert (no SQLite in the test)", async () => {
  const calls: string[] = [];
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: (r) => calls.push(r.trigger), recordOutcome: () => {} });
  // upsert receives a full LearningRule; assert trigger passes through
  await repo.save({ id: "r3", trigger: "new", action: "a", errorClass: "E-Z", archetype: null, status: "candidate", confidence: "medium", usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() });
  assert.deepEqual(calls, ["new"]);
});

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
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  const t1 = top.find((r) => r.trigger === "t1");
  assert.ok(t1, "the pending row must survive as a candidate, not be dropped");
  assert.equal(t1!.status, "candidate"); // coerced from 'pending'
});

test("topRules ranks via RuleGovernanceService — active before the coerced candidate", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, recordOutcome: () => {} });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(top.map((r) => r.trigger), ["t2", "t1"]); // active(0.5) before candidate(0.9)
});

// CRL-02: the `app` argument is threaded into the injected store's selectRules so the Plan-6 wiring
// closure cannot compile without supplying it. v1 stores ignore it (no per-app filtering yet); this
// pins only that the value reaches the seam, never that filtering happens (that is Phase 2).
test("topRules threads the app argument into the injected store.selectRules", async () => {
  const seenApps: string[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: (app) => { seenApps.push(app); return rows; },
    upsert: () => {},
    recordOutcome: () => {},
  });
  await repo.topRules("portfolio", Sha.of("abcdef1"), 10);
  assert.deepEqual(seenApps, ["portfolio"]);
});

test("rowToRule maps confidence exhaustively: low/medium/high pass through, unknown falls back to medium", async () => {
  // CRL-05: the exhaustive ternary must treat 'medium' as a first-class match (not a catch-all).
  // A 'medium' row passes through as-is; an unknown value also maps to 'medium' (safe fallback).
  const mediumRow = { id: "r4", trigger_text: "t4", action_text: "a4", error_class: "E-W", archetype: null, status: "active", confidence: "medium", usage_count: 0, outcome_count: 0, success_rate: null, last_verified: null, source: "oracle", at: "2026-01-04T00:00:00.000Z" };
  const unknownRow = { id: "r5", trigger_text: "t5", action_text: "a5", error_class: "E-V", archetype: null, status: "active", confidence: "very-high", usage_count: 0, outcome_count: 0, success_rate: null, last_verified: null, source: "oracle", at: "2026-01-05T00:00:00.000Z" };
  const repo = new SqliteLearningRepository({ selectRules: () => [mediumRow, unknownRow], upsert: () => {}, recordOutcome: () => {} });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  const t4 = top.find((r) => r.trigger === "t4");
  const t5 = top.find((r) => r.trigger === "t5");
  assert.equal(t4?.confidence, "medium", "'medium' row confidence must be 'medium' (first-class match)");
  assert.equal(t5?.confidence, "medium", "unknown confidence value must fall back to 'medium'");
});

test("save delegates to the injected upsert (no SQLite in the test)", async () => {
  const calls: string[] = [];
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: (r) => calls.push(r.trigger), recordOutcome: () => {} });
  // upsert receives a full LearningRule; assert trigger passes through
  await repo.save({ id: "r3", trigger: "new", action: "a", errorClass: "E-Z", archetype: null, status: "candidate", confidence: "medium", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() });
  assert.deepEqual(calls, ["new"]);
});

// CRL-04: pin applyOutcome → store.recordOutcome delegation. A regression breaking this
// (e.g. accidentally calling upsert or adding an early return) would not be caught by any
// of the other tests, since they all use recordOutcome: () => {} as a silent no-op.
test("applyOutcome delegates to store.recordOutcome exactly once with the outcome", async () => {
  const recordedOutcomes: import("@kernel/run-outcome.ts").RunOutcome[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    recordOutcome: (o) => recordedOutcomes.push(o),
  });
  const fakeOutcome: import("@kernel/run-outcome.ts").RunOutcome = {
    runId: "run-001", app: "test-app", sha: "abcdef1", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: new Date().toISOString(),
  };
  await repo.applyOutcome(fakeOutcome);
  assert.equal(recordedOutcomes.length, 1, "store.recordOutcome must be called exactly once");
  assert.strictEqual(recordedOutcomes[0], fakeOutcome, "store.recordOutcome must receive the exact outcome object");
});

// W3 fix (F3c, dual-judge round): topRules() forwards the optional relevance bias verbatim to
// RuleGovernanceService — pinned here so the port-boundary forwarding cannot silently drop it.
test("topRules forwards an optional relevance bias to RuleGovernanceService", async () => {
  const relevantRow = { id: "rel", trigger_text: "rel", action_text: "a", error_class: "E-EXEC-FAIL", archetype: null, status: "active", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.1, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const irrelevantRow = { id: "irrel", trigger_text: "irrel", action_text: "a", error_class: "E-FLAKY", archetype: null, status: "active", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.6, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const repo = new SqliteLearningRepository({ selectRules: () => [relevantRow, irrelevantRow], upsert: () => {}, recordOutcome: () => {} });

  const withoutBias = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(withoutBias.map((r) => r.trigger), ["irrel", "rel"], "no bias -> pure successRate ordering");

  const withBias = await repo.topRules("test-app", Sha.of("abcdef1"), 10, { errorClass: "E-EXEC-FAIL" });
  assert.deepEqual(withBias.map((r) => r.trigger), ["rel", "irrel"], "errorClass bias must be forwarded and flip the ordering");
});

// W3 fix (F3a, dual-judge round): incrementUsage delegates to the injected store's own
// incrementUsage when present, and tolerates its absence (optional store method).
test("incrementUsage delegates to the injected store.incrementUsage", async () => {
  const incremented: (readonly string[])[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    recordOutcome: () => {},
    incrementUsage: (ids) => { incremented.push(ids); },
  });
  await repo.incrementUsage(["r1", "r2"]);
  assert.deepEqual(incremented, [["r1", "r2"]]);
});

test("incrementUsage tolerates a store without incrementUsage wired", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: () => {}, recordOutcome: () => {} });
  await assert.doesNotReject(() => repo.incrementUsage(["r1"]));
});

// WS1.3 (full-flow remediation): listAll delegates to the injected store's own selectAllRules —
// UNFILTERED by status (unlike selectRules/topRules, which are retrieval-scoped to active/
// candidate) — and fails open to [] when the store doesn't implement it (mirrors incrementUsage's
// own optional-method convention on this same port).
test("listAll delegates to the injected store.selectAllRules, unfiltered by status", async () => {
  const deprecatedRow = { id: "dep", trigger_text: "t-dep", action_text: "a-dep", error_class: "E-X", archetype: null, status: "deprecated", confidence: "low", usage_count: 0, outcome_count: 5, success_rate: 0.1, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const seenArgs: Array<{ app: string; limit: number }> = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    recordOutcome: () => {},
    selectAllRules: (app, limit) => { seenArgs.push({ app, limit }); return [deprecatedRow]; },
  });

  const all = await repo.listAll("test-app", 200);

  assert.deepEqual(seenArgs, [{ app: "test-app", limit: 200 }]);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "deprecated", "listAll must NOT filter out deprecated rows (unlike topRules)");
});

test("listAll tolerates a store without selectAllRules wired (fail-open to [])", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: () => {}, recordOutcome: () => {} });
  const all = await repo.listAll("test-app", 200);
  assert.deepEqual(all, []);
});

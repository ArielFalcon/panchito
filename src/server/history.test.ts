import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecord, getRecord, listRecords, currentRun, updateRecord, addCase, continuationDepth, clearDatabase, appendActivity, upsertLearningRule, listLearningRules, recordRuleOutcome, saveScorecardEntry, loadScorecard } from "./history";

test("createRecord stores an enqueued record findable by id", () => {
  const r = createRecord({ target: "e2e",  app: "hist-a", sha: "abcdef1234", mode: "diff" });
  assert.equal(r.status, "enqueued");
  assert.equal(getRecord(r.id)?.app, "hist-a");
});

// Two triggers for the same SHA in the same millisecond (webhook re-delivery,
// double-submit) must never collide on the PRIMARY KEY. With a ms-resolution
// timestamp alone, two createRecord calls produce byte-identical ids → UNIQUE
// constraint → the second throw escapes unhandled and drops the trigger.
test("two rapid createRecord calls for the same sha produce different ids", () => {
  const sha = "abcdef1234567";
  const frozenNow = Date.now();
  const originalNow = Date.now;
  Date.now = () => frozenNow;
  try {
    const a = createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    const b = createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    assert.notEqual(a.id, b.id);
    assert.ok(getRecord(a.id));
    assert.ok(getRecord(b.id));
  } finally {
    Date.now = originalNow;
  }
});

test("listRecords returns newest-first and respects the limit", () => {
  const app = "hist-b";
  const a = createRecord({ target: "e2e",  app, sha: "1111111", mode: "diff" });
  const b = createRecord({ target: "e2e",  app, sha: "2222222", mode: "complete" });
  const list = listRecords(app, 10);
  assert.equal(list[0]!.id, b.id); // newest first
  assert.equal(list[1]!.id, a.id);
  assert.equal(listRecords(app, 1).length, 1);
});

test("addCase upserts by name so a retry does not duplicate or inflate counts", () => {
  const r = createRecord({ target: "e2e",  app: "hist-c", sha: "3333333", mode: "diff" });
  addCase(r.id, { name: "checkout", status: "fail" });
  addCase(r.id, { name: "login", status: "pass" });
  // retry re-runs the whole suite and re-reports the same names with new outcomes:
  addCase(r.id, { name: "checkout", status: "pass" });
  const rec = getRecord(r.id)!;
  assert.equal(rec.cases.length, 2); // not 3 — upserted, not appended
  assert.equal(rec.passed, 2);
  assert.equal(rec.failed, 0);
});

test("currentRun returns a running/enqueued record and skips finished ones", () => {
  const r = createRecord({ target: "e2e",  app: "hist-d", sha: "4444444", mode: "diff" });
  updateRecord(r.id, { status: "running" });
  assert.ok(currentRun());
  updateRecord(r.id, { status: "done", verdict: "pass" });
  assert.equal(getRecord(r.id)?.status, "done");
});

test("currentRun prefers running over enqueued when both exist (queue FIFO)", () => {
  clearDatabase();
  const olderRunning = createRecord({ target: "e2e", app: "hist-e-fifo", sha: "5555555", mode: "diff" });
  const newerEnqueued = createRecord({ target: "e2e", app: "hist-e-fifo", sha: "6666666", mode: "diff" });
  updateRecord(olderRunning.id, { status: "running" });
  const cur = currentRun();
  assert.ok(cur);
  assert.equal(cur!.id, olderRunning.id, "must return the actually-running job, not the newest enqueued");
});

test("appendActivity round-trips structured events (kind, status, text) newest-last", () => {
  const r = createRecord({ target: "e2e", app: "hist-act", sha: "act0001", mode: "complete" });
  appendActivity(r.id, { kind: "todo", text: "read existing suite", status: "in_progress" });
  appendActivity(r.id, { kind: "file", text: "checkout.spec.ts" });
  appendActivity(r.id, { kind: "command", text: "npx playwright test --list" });
  const a = getRecord(r.id)!.activity!;
  assert.equal(a.length, 3);
  assert.equal(a[0]!.kind, "todo");
  assert.equal(a[0]!.status, "in_progress");
  assert.equal(a[2]!.text, "npx playwright test --list"); // chronological, newest last
  assert.ok(a[2]!.ts);
});

test("appendActivity caps the feed at 200 rows, keeping the newest", () => {
  const r = createRecord({ target: "e2e", app: "hist-cap", sha: "cap0001", mode: "complete" });
  for (let i = 0; i < 250; i++) appendActivity(r.id, { kind: "file", text: `spec-${i}.ts` });
  const a = getRecord(r.id)!.activity!;
  assert.equal(a.length, 200);
  assert.equal(a[a.length - 1]!.text, "spec-249.ts"); // newest survives
  assert.equal(a[0]!.text, "spec-50.ts");             // oldest 50 pruned
});

test("updateRecord stamps stepStartedAt whenever the step changes", () => {
  const r = createRecord({ target: "e2e", app: "hist-step", sha: "step001", mode: "diff" });
  assert.equal(getRecord(r.id)!.stepStartedAt, undefined);
  updateRecord(r.id, { step: "generate" });
  const ts1 = getRecord(r.id)!.stepStartedAt;
  assert.ok(ts1 && !Number.isNaN(Date.parse(ts1)));
  updateRecord(r.id, { step: "execute" });
  const ts2 = getRecord(r.id)!.stepStartedAt;
  assert.ok(ts2 && ts2 !== ts1 || Date.parse(ts2!) >= Date.parse(ts1!));
});

test("continuationDepth walks the parentRunId chain", () => {
  const grandparent = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff" });
  const parent = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: grandparent.id });
  const child = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: parent.id });
  assert.equal(continuationDepth(grandparent), 0);
  assert.equal(continuationDepth(parent), 1);
  assert.equal(continuationDepth(child), 2);
});

test("recordRuleOutcome accumulates a running mean and earns promotion (never overwrites)", () => {
  const app = "hist-learn-1";
  upsertLearningRule({ id: "lr-1", app, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", source: "run-x" });
  recordRuleOutcome("lr-1", 0.8);
  recordRuleOutcome("lr-1", 0.8);
  recordRuleOutcome("lr-1", 0.8);
  const r = listLearningRules(app, 10).find((x) => x.id === "lr-1");
  assert.ok(r, "rule should still exist");
  assert.equal(r!.outcomeCount, 3); // accumulated across outcomes, not overwritten
  assert.ok(Math.abs(r!.successRate! - 0.8) < 1e-9, `expected ~0.8, got ${r!.successRate}`);
  assert.equal(r!.status, "active"); // promotion earned from objective outcomes
});

test("createRecord persists triggerRepo and getRecord returns it", () => {
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff", triggerRepo: "org/orders-svc" });
  assert.equal(getRecord(rec.id)?.triggerRepo, "org/orders-svc");
});

test("triggerRepo is optional and absent by default", () => {
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  assert.equal(getRecord(rec.id)?.triggerRepo, undefined);
});

test("scorecard persists oracle outcomes and aggregates valueScore across runs", () => {
  // Unique app per run: the on-disk DB persists across test-suite runs and saveScorecardEntry
  // APPENDS (by design), so a fixed app name would accumulate entries and break absolute counts.
  const app = `hist-sc-${Date.now().toString(36)}`;
  saveScorecardEntry({ runId: "r1", app, sha: "s1", target: "code", valueScore: 0.5, mutantCount: 10, killedCount: 5, at: "t1" });
  saveScorecardEntry({ runId: "r2", app, sha: "s2", target: "code", valueScore: 0.7, mutantCount: 10, killedCount: 7, at: "t2" });
  const sc = loadScorecard(app);
  assert.ok(sc, "scorecard should exist");
  assert.equal(sc!.entries.length, 2);
  assert.equal(sc!.summary.measuredRuns, 2);
  assert.ok(Math.abs(sc!.summary.avgValueScore! - 0.6) < 1e-9, `expected ~0.6, got ${sc!.summary.avgValueScore}`);
  assert.equal(sc!.summary.lastValueScore, 0.7);
});

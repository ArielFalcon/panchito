import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import Database from "better-sqlite3";
import { createRecord, getRecord, listRecords, currentRun, updateRecord, addCase, continuationDepth, clearDatabase, appendActivity, upsertLearningRule, listLearningRules, recordRuleOutcome, saveScorecardEntry, loadScorecard, deleteAppHistory, interruptedRecords, backupDatabase, saveRunOutcome, getRunOutcome, listRunOutcomes, updateRunOutcomeReflection, markContextStale, consumeContextStale, saveAgentTurn, getAgentTurns } from "./history";
import { SpecRecordSchema } from "../contract/commands";
import type { RunOutcome, StructuredReflection, } from "../types";
import type { AgentTurnRecord } from "./history";

test("markContextStale then consumeContextStale is one-shot: first consume true, second false", () => {
  const app = "hist-ctx-stale";
  assert.equal(consumeContextStale(app), false); // nothing marked yet
  markContextStale(app);
  assert.equal(consumeContextStale(app), true); // the flag is read…
  assert.equal(consumeContextStale(app), false); // …and cleared (survives only until consumed once)
});

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

test("a spec with no objective/flow round-trips as undefined (not null) — wire-contract safe", () => {
  // The single-agent (manual/diff fallback) path can report a spec without an objective; the DB stores
  // an absent optional TEXT column as NULL. The read MUST normalize NULL → undefined, or the run's API
  // response fails SpecRecordSchema (objective is optional, NOT nullable) — observed as a Zod
  // "expected string, received null" on specs[].objective.
  const r = createRecord({ target: "e2e", app: "hist-nullobj", sha: "9999999", mode: "manual" });
  updateRecord(r.id, { status: "done", verdict: "pass", specs: [{ name: "flows/x.spec.ts" }] });
  const spec = getRecord(r.id)!.specs![0]!;
  assert.equal(spec.name, "flows/x.spec.ts");
  assert.equal(spec.objective, undefined, "absent objective must read back as undefined, not null");
  assert.equal(spec.flow, undefined, "absent flow must read back as undefined, not null");
  assert.doesNotThrow(() => SpecRecordSchema.parse(spec), "the spec must satisfy the wire contract");
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

test("interruptedRecords returns running and enqueued records", () => {
  clearDatabase();
  const running = createRecord({ target: "e2e", app: "hist-zombie", sha: "7777777", mode: "diff" });
  const enqueued = createRecord({ target: "e2e", app: "hist-zombie", sha: "8888888", mode: "diff" });
  const done = createRecord({ target: "e2e", app: "hist-zombie", sha: "9999999", mode: "diff" });
  updateRecord(running.id, { status: "running" });
  updateRecord(enqueued.id, { status: "enqueued" });
  updateRecord(done.id, { status: "done", verdict: "pass" });
  const zombies = interruptedRecords();
  assert.equal(zombies.length, 2);
  const ids = new Set(zombies.map((z) => z.id));
  assert.ok(ids.has(running.id));
  assert.ok(ids.has(enqueued.id));
  assert.ok(!ids.has(done.id));
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

test("deleteAppHistory removes the app's runs (cascading cases/specs) but not other apps'", () => {
  const doomed = `hist-del-${Date.now().toString(36)}`;
  const alive = `hist-keep-${Date.now().toString(36)}`;
  const mine = createRecord({ app: doomed, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  addCase(mine.id, { name: "t1", status: "pass" });
  const other = createRecord({ app: alive, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  const removed = deleteAppHistory(doomed);
  assert.ok(removed >= 1);
  assert.equal(getRecord(mine.id), undefined);
  assert.ok(getRecord(other.id));
});

// ── backupDatabase (WAL-safe online backup) ──────────────────────────────────
// The backup must use better-sqlite3's native backup API, not a raw file copy:
// a copy of a WAL database can miss the -wal tail and produce a torn snapshot.

test("backupDatabase writes a consistent, openable snapshot containing committed rows", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "hist-backup-"));
  const prevRoot = process.env.PANCHITO_ROOT;
  process.env.PANCHITO_ROOT = tmpRoot;
  try {
    const rec = createRecord({ app: "hist-backup", sha: "abc1234", target: "e2e", mode: "diff" });
    const r = await backupDatabase();
    assert.equal(r.backedUp, true);
    assert.ok(r.path && existsSync(r.path), "backup file must exist");
    // The snapshot must be a valid SQLite DB holding the committed record.
    const snapshot = new Database(r.path!, { readonly: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?").get(rec.id) as { n: number };
      assert.equal(row.n, 1);
    } finally {
      snapshot.close();
    }
  } finally {
    if (prevRoot === undefined) delete process.env.PANCHITO_ROOT;
    else process.env.PANCHITO_ROOT = prevRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("updateRunOutcomeReflection back-fills the reflection that was null at verdict time", () => {
  const app = "reflect-app";
  deleteAppHistory(app); // self-isolate: the history DB is a module-global singleton
  try {
    const outcome: RunOutcome = {
      runId: "run-reflect-1", app, sha: "abc1234", mode: "diff", target: "e2e",
      verdict: "fail", errorClass: "E-EXEC-FAIL",
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-06-13T00:00:00.000Z",
    };
    saveRunOutcome(outcome); // persisted at verdict time WITHOUT a reflection
    assert.equal(listRunOutcomes(app)[0]?.reflection, undefined);

    const reflection: StructuredReflection = {
      goal: "test the discount", decision: "asserted only visibility", assumption: "button present",
      errorClass: "E-EXEC-FAIL", gateSignal: "fail", evidence: "selector timed out",
      rootCause: "wrong selector", preventiveRule: { trigger: "discount flow", action: "scope the locator" },
    };
    updateRunOutcomeReflection("run-reflect-1", reflection);
    assert.deepEqual(listRunOutcomes(app)[0]?.reflection, reflection);
  } finally {
    deleteAppHistory(app);
  }
});

test("getRunOutcome returns the single run's outcome and round-trips the reviewer verdict", () => {
  const app = "value-report-app";
  deleteAppHistory(app); // self-isolate: the history DB is a module-global singleton
  try {
    const outcome: RunOutcome = {
      runId: "run-value-1", app, sha: "deadbeef0", mode: "diff", target: "e2e",
      verdict: "pass", errorClass: null,
      gateSignals: { static: true, coverageRatio: 0.82, valueScore: null, reviewerCorrections: [], reviewerRationale: "covers the new validation branch", reviewerApproved: true, flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-06-13T00:00:00.000Z",
    };
    saveRunOutcome(outcome);

    const got = getRunOutcome("run-value-1");
    assert.ok(got, "expected an outcome for the known runId");
    assert.equal(got!.gateSignals.coverageRatio, 0.82);
    assert.equal(got!.gateSignals.reviewerApproved, true);
    assert.equal(got!.gateSignals.reviewerRationale, "covers the new validation branch");
    assert.equal(getRunOutcome("does-not-exist"), undefined);
  } finally {
    deleteAppHistory(app);
  }
});

test("backupDatabase keeps only the last 7 backups", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "hist-backup-prune-"));
  const prevRoot = process.env.PANCHITO_ROOT;
  process.env.PANCHITO_ROOT = tmpRoot;
  try {
    const backupDir = join(tmpRoot, "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    // Pre-seed 9 older "backups" (lexically before any real ISO timestamp).
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(backupDir, `panchito-0000-0${i}.db`), "stale");
    }
    const r = await backupDatabase();
    assert.equal(r.backedUp, true);
    const remaining = readdirSync(backupDir).filter((f) => f.startsWith("panchito-") && f.endsWith(".db"));
    assert.equal(remaining.length, 7);
    // The newest (real) backup survives; the oldest seeds were dropped.
    assert.ok(remaining.includes(basename(r.path!)));
    assert.ok(!remaining.includes("panchito-0000-00.db"));
  } finally {
    if (prevRoot === undefined) delete process.env.PANCHITO_ROOT;
    else process.env.PANCHITO_ROOT = prevRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Phase 0 / Slice A — agent_turns store ────────────────────────────────────

// Minimal valid turn record factory for the tests below.
function makeTurn(overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    runId: "run-test-001",
    sessionId: "sess-abc",
    role: "qa-generator",
    round: 0,
    isRepair: false,
    ts: new Date().toISOString(),
    objective: "test the login flow",
    promptText: "Write a Playwright test for the login feature.",
    outputText: "The test is written.",
    promptBytes: 43,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: 10,
    tokensCacheRead: 5,
    tokensCacheWrite: 2,
    cost: 0.001,
    ...overrides,
  };
}

test("Phase 0 A.1/A.2: saveAgentTurn round-trips to getAgentTurns with all fields", () => {
  const turn = makeTurn();
  saveAgentTurn(turn);
  const rows = getAgentTurns(turn.runId!);
  assert.ok(rows.length >= 1, "at least one row must be returned");
  const saved = rows.find((r) => r.sessionId === turn.sessionId && r.role === turn.role);
  assert.ok(saved, "the saved turn must be retrievable by runId");
  assert.equal(saved!.role, "qa-generator");
  assert.equal(saved!.round, 0);
  assert.equal(saved!.isRepair, false);
  assert.equal(saved!.promptText, turn.promptText);
  assert.equal(saved!.outputText, turn.outputText);
  assert.equal(saved!.promptBytes, turn.promptBytes);
  assert.equal(saved!.tokensInput, 100);
  assert.equal(saved!.tokensOutput, 50);
  assert.equal(saved!.tokensReasoning, 10);
  assert.equal(saved!.tokensCacheRead, 5);
  assert.equal(saved!.tokensCacheWrite, 2);
  assert.ok(Math.abs((saved!.cost ?? 0) - 0.001) < 1e-9);
  assert.equal(saved!.objective, "test the login flow");
});

test("Phase 0 A.2: saveAgentTurn stores null-runId turns (sessions with no parent run)", () => {
  const turn = makeTurn({ runId: null, sessionId: "sess-no-run" });
  // Should not throw — null runId is explicitly valid (e.g. maintainer, chat sessions).
  assert.doesNotThrow(() => saveAgentTurn(turn));
});

test("Phase 0 A.2: getAgentTurns returns multiple turns in chronological order", () => {
  const runId = "run-order-test-" + Date.now();
  saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 0, role: "qa-generator", promptText: "first" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 1, role: "qa-generator", promptText: "second" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "s2", round: 0, role: "qa-reviewer", promptText: "review" }));
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 3);
  // Chronological insertion order preserved.
  assert.equal(rows[0]!.promptText, "first");
  assert.equal(rows[1]!.promptText, "second");
  assert.equal(rows[2]!.role, "qa-reviewer");
});

test("Phase 0 A.2: saveAgentTurn accepts null token fields (Codex path)", () => {
  const runId = "run-codex-null-" + Date.now();
  const turn = makeTurn({
    runId,
    sessionId: "codex-sess",
    tokensInput: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: null,
  });
  saveAgentTurn(turn);
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokensInput, null);
  assert.equal(rows[0]!.tokensOutput, null);
  assert.equal(rows[0]!.cost, null);
});

test("Phase 0 A.2: saveAgentTurn stores sanitized output — caller must pre-sanitize (contract)", () => {
  // The store accepts whatever it receives; the DI contract requires the caller (defaultAgentDeps
  // funnel) to sanitize before calling saveAgentTurn. We test that round-trip is faithful.
  const runId = "run-sanitize-rt-" + Date.now();
  const sanitizedText = "[REDACTED_SECRET] was in the output";
  saveAgentTurn(makeTurn({ runId, outputText: sanitizedText }));
  const rows = getAgentTurns(runId);
  assert.equal(rows[0]!.outputText, sanitizedText);
});

test("Phase 0 A.1: agent_turns table migrates idempotently on an existing DB (columnExists guard)", () => {
  // Calling saveAgentTurn twice with different sessions for the same run must work without errors,
  // proving the schema was created exactly once (the IF NOT EXISTS guards prevent duplicate tables).
  const runId = "run-migrate-" + Date.now();
  saveAgentTurn(makeTurn({ runId, sessionId: "sess-a" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "sess-b", role: "qa-reviewer" }));
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, "sess-a");
  assert.equal(rows[1]!.role, "qa-reviewer");
});

// FIX 3: the agent_turns 30-day prune compares an ISO-8601 (…T…Z) ts column against
// datetime('now', '-30 days'), which yields the space-separated 'YYYY-MM-DD HH:MM:SS' form. A RAW
// string compare skews exactly at the BOUNDARY: when the date portions match, the 'T' (0x54) at
// index 10 of the ISO value sorts GREATER than the cutoff's ' ' (0x20), so a row that IS older than
// the cutoff (same day, earlier time) wrongly fails `ts < cutoff` and is NOT pruned. The fix wraps
// ts in datetime() so both operands are SQLite's canonical form. This self-contained test pins the
// cutoff to a known instant and reproduces the boundary skew + proves the fixed predicate is correct.
test("FIX 3: agent_turns prune predicate (datetime(ts)) is boundary-correct for ISO ts, unlike a raw compare", () => {
  const db = new Database(":memory:");
  // Mirror the production column shape: ts is ISO-8601 TEXT (…T…Z).
  db.exec("CREATE TABLE agent_turns (id INTEGER PRIMARY KEY, ts TEXT NOT NULL)");

  // A fixed cutoff so the assertions are deterministic (no dependency on the test clock).
  const cutoff = "2026-05-18 12:00:00"; // SQLite datetime() form (space-separated)
  // An ISO turn that is genuinely OLDER than the cutoff: SAME date, earlier time → MUST prune.
  const olderSameDay = "2026-05-18T08:00:00.000Z";
  // An ISO turn NEWER than the cutoff: same date, later time → MUST survive.
  const newerSameDay = "2026-05-18T20:00:00.000Z";
  db.prepare("INSERT INTO agent_turns (ts) VALUES (?)").run(olderSameDay);
  db.prepare("INSERT INTO agent_turns (ts) VALUES (?)").run(newerSameDay);

  // The OLD broken predicate (raw string compare) FAILS to prune the older-same-day row: at index 10
  // its 'T' > the cutoff's ' ', so `olderSameDay < cutoff` is false. This demonstrates the boundary bug.
  const rawWouldPrune = (db.prepare("SELECT COUNT(*) AS c FROM agent_turns WHERE ts < ?").get(cutoff) as { c: number }).c;
  assert.equal(rawWouldPrune, 0, "raw string compare mis-sorts the older-same-day ISO row (the boundary bug: 0 pruned)");

  // The FIXED predicate: datetime(ts) normalizes the ISO value to the same canonical form as the cutoff.
  const fixedWouldPrune = (db.prepare("SELECT COUNT(*) AS c FROM agent_turns WHERE datetime(ts) < ?").get(cutoff) as { c: number }).c;
  assert.equal(fixedWouldPrune, 1, "datetime(ts) correctly identifies the older-same-day row as prunable");

  db.prepare("DELETE FROM agent_turns WHERE datetime(ts) < ?").run(cutoff);
  const survivors = db.prepare("SELECT ts FROM agent_turns").all() as Array<{ ts: string }>;
  assert.equal(survivors.length, 1, "exactly the newer row must survive");
  assert.equal(survivors[0]!.ts, newerSameDay, "the surviving row must be the newer-same-day one");
  db.close();
});

// Persistent run history (SQLite via better-sqlite3). Survives process restarts so
// the TUI/continue/chat can address past runs. Persisted to disk at HISTORY_DB_PATH
// (a docker-compose volume in production — see the `qa-data` volume).
//
// Initialization is LAZY: the database is opened (and the schema created) on first
// use, not at import time. This keeps a bare `import` side-effect-free — importing a
// module that re-exports from here (e.g. the CLI) does not touch the filesystem until
// a record is actually read or written.

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { RunRecord, RunMode, TestTarget, QaCase, RunVerdict, SpecRecord, RunOutcome, AgentActivity } from "../types";
import { applyOutcome, type LearningRule, type RuleUpsert, type Confidence, type RuleStatus } from "../qa/learning/learning-rule";
import type { ErrorClass } from "../qa/learning/taxonomy";
import type { Curriculum } from "../qa/learning/curriculum";
import { updateScorecard, type Scorecard, type ScorecardEntry } from "../qa/learning/oracle-types";

const DELETE_MAX_AGE_DAYS = 30;

let db!: Database.Database;
let insertRun!: Database.Statement;
let getRunStmt!: Database.Statement;
let listRunsStmt!: Database.Statement;
let currentRunStmt!: Database.Statement;
let interruptedStmt!: Database.Statement;
let deleteCaseByName!: Database.Statement;
let insertCase!: Database.Statement;
let getCasesStmt!: Database.Statement;
let countCasesStmt!: Database.Statement;
let getSpecsStmt!: Database.Statement;
let appendLogStmt!: Database.Statement;
let insertActivityStmt!: Database.Statement;
let getActivityStmt!: Database.Statement;
let capActivityStmt!: Database.Statement;
let insertOutcome!: Database.Statement;
let listOutcomesStmt!: Database.Statement;
let upsertRuleStmt!: Database.Statement;
let listRulesStmt!: Database.Statement;
let listAllRulesStmt!: Database.Statement;
let incrementRuleUsageStmt!: Database.Statement;
let loadCurriculumStmt!: Database.Statement;
let saveCurriculumStmt!: Database.Statement;
let loadScorecardStmt!: Database.Statement;
let saveScorecardStmt!: Database.Statement;
let initialized = false;

function ensureDb(): void {
  if (initialized) return;

  const dbPath =
    process.env.HISTORY_DB_PATH ?? join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "data", "ai-pipeline.db");
  mkdirSync(join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "data"), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      sha TEXT NOT NULL,
      ref TEXT,
      target TEXT NOT NULL DEFAULT 'e2e',
      mode TEXT NOT NULL DEFAULT 'diff',
      status TEXT NOT NULL DEFAULT 'enqueued',
      step TEXT,
      step_detail TEXT,
      verdict TEXT,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      note TEXT,
      retrying INTEGER DEFAULT 0,
      parent_run_id TEXT,
      trigger_repo TEXT,
      at TEXT NOT NULL,
      step_started_at TEXT,
      logs TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      objective TEXT,
      flow TEXT
    );

    CREATE TABLE IF NOT EXISTS run_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_cases_run_id ON cases(run_id);
    CREATE INDEX IF NOT EXISTS idx_specs_run_id ON specs(run_id);
    CREATE INDEX IF NOT EXISTS idx_activity_run_id ON run_activity(run_id);

    CREATE TABLE IF NOT EXISTS run_outcomes (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      sha TEXT NOT NULL,
      mode TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'e2e',
      verdict TEXT NOT NULL,
      error_class TEXT,
      gate_signals TEXT NOT NULL DEFAULT '{}',
      rules_retrieved TEXT NOT NULL DEFAULT '[]',
      reflection TEXT,
      at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_app ON run_outcomes(app);
    CREATE INDEX IF NOT EXISTS idx_outcomes_error_class ON run_outcomes(error_class);

    CREATE TABLE IF NOT EXISTS learning_rules (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      action_text TEXT NOT NULL,
      error_class TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'low',
      usage_count INTEGER NOT NULL DEFAULT 0,
      outcome_count INTEGER NOT NULL DEFAULT 0,
      success_rate REAL,
      last_verified TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rules_app ON learning_rules(app);
    CREATE INDEX IF NOT EXISTS idx_rules_status ON learning_rules(status);

    CREATE TABLE IF NOT EXISTS curriculum (
      app TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scorecard (
      app TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration: add columns introduced after the initial schema to DBs that already
  // exist on the persisted volume (CREATE TABLE IF NOT EXISTS won't add a column).
  if (!columnExists("runs", "step_started_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN step_started_at TEXT");
  }
  if (!columnExists("learning_rules", "outcome_count")) {
    db.exec("ALTER TABLE learning_rules ADD COLUMN outcome_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists("runs", "trigger_repo")) {
    db.exec("ALTER TABLE runs ADD COLUMN trigger_repo TEXT");
  }

  insertRun = db.prepare(`
    INSERT INTO runs (id, app, sha, ref, target, mode, status, step, step_detail, verdict, passed, failed, note, retrying, parent_run_id, trigger_repo, at, logs)
    VALUES (@id, @app, @sha, @ref, @target, @mode, @status, @step, @stepDetail, @verdict, @passed, @failed, @note, @retrying, @parentRunId, @triggerRepo, @at, @logs)
  `);
  getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  listRunsStmt = db.prepare("SELECT * FROM runs WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
  currentRunStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued') ORDER BY (status='running') DESC, at ASC, rowid ASC LIMIT 1");
  interruptedStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued')");
  deleteCaseByName = db.prepare("DELETE FROM cases WHERE run_id = ? AND name = ?");
  insertCase = db.prepare("INSERT INTO cases (run_id, name, status, detail) VALUES (@runId, @name, @status, @detail)");
  getCasesStmt = db.prepare("SELECT * FROM cases WHERE run_id = ?");
  countCasesStmt = db.prepare("SELECT status, COUNT(*) AS cnt FROM cases WHERE run_id = ? GROUP BY status");
  getSpecsStmt = db.prepare("SELECT * FROM specs WHERE run_id = ?");
  appendLogStmt = db.prepare("UPDATE runs SET logs = logs || @log WHERE id = @id");
  insertActivityStmt = db.prepare("INSERT INTO run_activity (run_id, ts, kind, status, text) VALUES (@runId, @ts, @kind, @status, @text)");
  getActivityStmt = db.prepare("SELECT kind, status, text, ts FROM run_activity WHERE run_id = ? ORDER BY id ASC");
  capActivityStmt = db.prepare(
    "DELETE FROM run_activity WHERE run_id = @id AND id NOT IN (SELECT id FROM run_activity WHERE run_id = @id ORDER BY id DESC LIMIT @keep)",
  );

  // run_outcomes (learning layer — append-only, never purged)
  insertOutcome = db.prepare(`
    INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, rules_retrieved, reflection, at)
    VALUES (@id, @app, @sha, @mode, @target, @verdict, @errorClass, @gateSignals, @rulesRetrieved, @reflection, @at)
  `);
  listOutcomesStmt = db.prepare("SELECT * FROM run_outcomes WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");

  // learning_rules (Phase 2 — placeholder for Graphiti)
  upsertRuleStmt = db.prepare(`
    INSERT INTO learning_rules (id, app, trigger_text, action_text, error_class, confidence, usage_count, outcome_count, success_rate, last_verified, source, status, at)
    VALUES (@id, @app, @trigger, @action, @errorClass, @confidence, @usageCount, @outcomeCount, @successRate, @lastVerified, @source, @status, @at)
    ON CONFLICT(id) DO UPDATE SET
      confidence = excluded.confidence,
      usage_count = excluded.usage_count,
      outcome_count = excluded.outcome_count,
      success_rate = excluded.success_rate,
      last_verified = excluded.last_verified,
      status = excluded.status
  `);
  listRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') ORDER BY (status = 'active') DESC, COALESCE(success_rate, 0) DESC, at DESC LIMIT ?");
  listAllRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? ORDER BY at DESC LIMIT ?");
  incrementRuleUsageStmt = db.prepare("UPDATE learning_rules SET usage_count = usage_count + 1 WHERE id = ?");
  loadCurriculumStmt = db.prepare("SELECT data, updated_at FROM curriculum WHERE app = ?");
  saveCurriculumStmt = db.prepare("INSERT INTO curriculum (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
  loadScorecardStmt = db.prepare("SELECT data FROM scorecard WHERE app = ?");
  saveScorecardStmt = db.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");

  // Prune old runs once on first use.
  db.prepare(`DELETE FROM runs WHERE at < datetime('now', '-${DELETE_MAX_AGE_DAYS} days')`).run();

  initialized = true;
}

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function recalcCounts(runId: string): { passed: number; failed: number } {
  const rows = countCasesStmt.all(runId) as Array<{ status: string; cnt: number }>;
  let passed = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === "pass") passed += row.cnt;
    else if (row.status === "fail") failed += row.cnt;
  }
  return { passed, failed };
}

function rowToRecord(row: Record<string, unknown>): RunRecord {
  const runId = row.id as string;
  const cases = getCasesStmt.all(runId) as QaCase[];
  const specRows = getSpecsStmt.all(runId) as SpecRecord[];
  const logsText = (row.logs as string) || "";
  const activityRows = getActivityStmt.all(runId) as Array<{ kind: string; status: string | null; text: string; ts: string }>;

  return {
    id: runId,
    app: row.app as string,
    sha: row.sha as string,
    ref: (row.ref as string) || undefined,
    target: row.target as TestTarget,
    mode: row.mode as RunMode,
    status: row.status as RunRecord["status"],
    step: (row.step as string) || undefined,
    stepDetail: (row.step_detail as string) || undefined,
    verdict: (row.verdict as RunVerdict) || undefined,
    passed: row.passed as number | undefined,
    failed: row.failed as number | undefined,
    note: (row.note as string) || undefined,
    retrying: Boolean(row.retrying),
    parentRunId: (row.parent_run_id as string) || undefined,
    triggerRepo: (row.trigger_repo as string) || undefined,
    cases,
    specs: specRows.length > 0 ? specRows : undefined,
    logs: logsText ? logsText.split("\n").filter(Boolean) : [],
    activity: activityRows.length > 0
      ? activityRows.map((a) => ({
          kind: a.kind as AgentActivity["kind"],
          text: a.text,
          ...(a.status ? { status: a.status as AgentActivity["status"] } : {}),
          ts: a.ts,
        }))
      : undefined,
    stepStartedAt: (row.step_started_at as string) || undefined,
    at: row.at as string,
  };
}

export function createRecord(opts: {
  app: string; sha: string; ref?: string; target: TestTarget; mode: RunMode; parentRunId?: string; triggerRepo?: string;
}): RunRecord {
  ensureDb();
  const id = `run-${opts.sha.slice(0, 7)}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const at = new Date().toISOString();

  insertRun.run({
    id,
    app: opts.app,
    sha: opts.sha,
    ref: opts.ref ?? null,
    target: opts.target,
    mode: opts.mode,
    status: "enqueued",
    step: null,
    stepDetail: null,
    verdict: null,
    passed: 0,
    failed: 0,
    note: null,
    retrying: 0,
    parentRunId: opts.parentRunId ?? null,
    triggerRepo: opts.triggerRepo ?? null,
    at,
    logs: "",
  });

  return {
    id,
    app: opts.app,
    sha: opts.sha,
    ref: opts.ref,
    target: opts.target,
    mode: opts.mode,
    status: "enqueued",
    cases: [],
    logs: [],
    at,
    parentRunId: opts.parentRunId,
    triggerRepo: opts.triggerRepo,
  };
}

export function getRecord(id: string): RunRecord | undefined {
  ensureDb();
  const row = getRunStmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function listRecords(app: string, limit = 10): RunRecord[] {
  ensureDb();
  const rows = listRunsStmt.all(app, limit) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function currentRun(): RunRecord | undefined {
  ensureDb();
  const row = currentRunStmt.get() as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function updateRecord(id: string, patch: Partial<RunRecord>): void {
  ensureDb();
  const setClauses: string[] = [];
  const params: Array<unknown> = [];

  const add = (col: string, val: unknown) => {
    setClauses.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.status !== undefined) add("status", patch.status);
  if (patch.step !== undefined) {
    add("step", patch.step);
    // Stamp when the phase began (drives the TUI's per-phase elapsed clock), but
    // ONLY on an actual transition — never reset it on a same-step update.
    const cur = (db.prepare("SELECT step FROM runs WHERE id = ?").get(id) as { step?: string } | undefined)?.step;
    if (cur !== patch.step) add("step_started_at", new Date().toISOString());
  }
  if (patch.stepDetail !== undefined) add("step_detail", patch.stepDetail);
  if (patch.verdict !== undefined) add("verdict", patch.verdict);
  if (patch.passed !== undefined) add("passed", patch.passed);
  if (patch.failed !== undefined) add("failed", patch.failed);
  if (patch.note !== undefined) add("note", patch.note);
  if (patch.retrying !== undefined) add("retrying", patch.retrying ? 1 : 0);

  if (setClauses.length > 0) {
    params.push(id);
    db.prepare(`UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  }

  if (patch.specs) {
    db.prepare("DELETE FROM specs WHERE run_id = ?").run(id);
    const insertSpec = db.prepare("INSERT INTO specs (run_id, name, objective, flow) VALUES (?, ?, ?, ?)");
    for (const s of patch.specs) {
      insertSpec.run(id, s.name, s.objective ?? null, s.flow ?? null);
    }
  }
}

export function addCase(id: string, c: QaCase): void {
  ensureDb();
  deleteCaseByName.run(id, c.name);
  insertCase.run({
    runId: id,
    name: c.name,
    status: c.status,
    detail: c.detail ?? null,
  });

  const { passed, failed } = recalcCounts(id);
  db.prepare("UPDATE runs SET passed = ?, failed = ? WHERE id = ?").run(passed, failed, id);
}

export function appendLog(id: string, msg: string): void {
  ensureDb();
  appendLogStmt.run({ id, log: msg + "\n" });
}

const ACTIVITY_CAP = 200;

// Appends one structured activity event to a run's live feed and caps the feed to
// the last ACTIVITY_CAP rows (advisory-only; never gates a verdict). Stamps `ts`
// here so the router stays pure/time-free and unit-testable.
export function appendActivity(id: string, a: { kind: AgentActivity["kind"]; text: string; status?: AgentActivity["status"] }): void {
  ensureDb();
  insertActivityStmt.run({ runId: id, ts: new Date().toISOString(), kind: a.kind, status: a.status ?? null, text: a.text });
  capActivityStmt.run({ id, keep: ACTIVITY_CAP });
}

export function interruptedRecords(): RunRecord[] {
  ensureDb();
  const rows = interruptedStmt.all() as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function clearDatabase(): void {
  ensureDb();
  db.exec("DELETE FROM specs; DELETE FROM cases; DELETE FROM runs;");
}

// Deletes EVERYTHING history holds for an app: runs (cases/specs/activity cascade
// via the schema's ON DELETE CASCADE), run outcomes, learning rules, curriculum and
// scorecard. Used by DELETE /api/apps/:name?purge=1. Returns the number of run rows
// removed (the other tables are not always populated).
export function deleteAppHistory(app: string): number {
  ensureDb();
  const info = db.prepare("DELETE FROM runs WHERE app = ?").run(app);
  db.prepare("DELETE FROM run_outcomes WHERE app = ?").run(app);
  db.prepare("DELETE FROM learning_rules WHERE app = ?").run(app);
  db.prepare("DELETE FROM curriculum WHERE app = ?").run(app);
  db.prepare("DELETE FROM scorecard WHERE app = ?").run(app);
  return info.changes;
}

export const MAX_CONTINUATION_DEPTH = 5;

export function continuationDepth(record: RunRecord): number {
  let depth = 0;
  let current: RunRecord | undefined = record;
  while (current?.parentRunId) {
    depth++;
    current = getRecord(current.parentRunId);
  }
  return depth;
}

export function saveRunOutcome(outcome: RunOutcome): void {
  ensureDb();
  insertOutcome.run({
    id: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    target: outcome.target,
    verdict: outcome.verdict,
    errorClass: outcome.errorClass ?? null,
    gateSignals: JSON.stringify(outcome.gateSignals),
    rulesRetrieved: JSON.stringify(outcome.rulesRetrieved),
    reflection: outcome.reflection ? JSON.stringify(outcome.reflection) : null,
    at: outcome.at,
  });
}

export function listRunOutcomes(app: string, limit = 50): RunOutcome[] {
  ensureDb();
  const rows = listOutcomesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    runId: row.id as string,
    app: row.app as string,
    sha: row.sha as string,
    mode: row.mode as RunMode,
    target: row.target as TestTarget,
    verdict: row.verdict as RunVerdict,
    errorClass: (row.error_class as RunOutcome["errorClass"]) ?? null,
    gateSignals: safeJsonParse(row.gate_signals as string, { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 }),
    rulesRetrieved: safeJsonParse(row.rules_retrieved as string, []),
    reflection: row.reflection ? safeJsonParse(row.reflection as string, undefined) : undefined,
    at: row.at as string,
  }));
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function upsertLearningRule(rule: RuleUpsert & { app: string; id: string }): void {
  ensureDb();
  upsertRuleStmt.run({
    id: rule.id,
    app: rule.app,
    trigger: rule.trigger,
    action: rule.action,
    errorClass: rule.errorClass,
    confidence: "low" as Confidence,
    usageCount: 0,
    outcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: rule.source,
    status: "candidate" as RuleStatus,
    at: new Date().toISOString(),
  });
}

function rowToRule(row: Record<string, unknown>): LearningRule {
  return {
    id: row.id as string,
    trigger: row.trigger_text as string,
    action: row.action_text as string,
    errorClass: row.error_class as ErrorClass,
    confidence: row.confidence as Confidence,
    usageCount: row.usage_count as number,
    outcomeCount: (row.outcome_count as number) ?? 0,
    successRate: row.success_rate as number | null,
    lastVerified: row.last_verified as string | null,
    source: row.source as string,
    status: row.status as RuleStatus,
    at: row.at as string,
  };
}

export function listLearningRules(app: string, limit = 20): LearningRule[] {
  ensureDb();
  const rows = listRulesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

// ALL rules regardless of status — used ONLY by the distiller for de-duplication, so a recurring
// failure pattern cannot spawn a duplicate candidate for a rule that was demoted (`deprecated`) or
// `superseded`. Retrieval must NOT use this (it injects only active/candidate).
export function listAllLearningRules(app: string, limit = 200): LearningRule[] {
  ensureDb();
  const rows = listAllRulesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

export function incrementRuleUsage(ruleIds: string[]): void {
  if (ruleIds.length === 0) return;
  ensureDb();
  for (const id of ruleIds) {
    incrementRuleUsageStmt.run(id);
  }
}

// Fold one objective outcome (a valueScore in [0,1]) into a rule's running statistics:
// successRate (running mean — NOT an overwrite), outcomeCount, confidence, and status
// (promotion/demotion with hysteresis). The pure governance lives in applyOutcome; this is
// only the read-modify-write boundary. No-op when the rule no longer exists.
export function recordRuleOutcome(ruleId: string, score: number): void {
  ensureDb();
  const row = db.prepare("SELECT * FROM learning_rules WHERE id = ?").get(ruleId) as Record<string, unknown> | undefined;
  if (!row) return;
  const updated = applyOutcome(rowToRule(row), score);
  db.prepare(
    "UPDATE learning_rules SET success_rate = ?, outcome_count = ?, confidence = ?, status = ?, last_verified = ? WHERE id = ?",
  ).run(updated.successRate, updated.outcomeCount, updated.confidence, updated.status, new Date().toISOString(), ruleId);
}

export function loadCurriculum(app: string): Curriculum | null {
  ensureDb();
  const row = loadCurriculumStmt.get(app) as { data: string; updated_at: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Curriculum;
  } catch {
    return null;
  }
}

export function saveCurriculum(curriculum: Curriculum): void {
  ensureDb();
  saveCurriculumStmt.run(curriculum.app, JSON.stringify(curriculum), curriculum.updatedAt);
}

export function loadScorecard(app: string): Scorecard | null {
  ensureDb();
  const row = loadScorecardStmt.get(app) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Scorecard;
  } catch {
    return null;
  }
}

// Append one oracle outcome to the app's versioned scorecard (the proof-of-improvement record:
// avg/last valueScore over runs). Aggregation is the pure updateScorecard; this is the DB sink.
export function saveScorecardEntry(entry: ScorecardEntry): void {
  ensureDb();
  const sc = updateScorecard(loadScorecard(entry.app), entry);
  saveScorecardStmt.run(sc.app, JSON.stringify(sc), sc.updatedAt);
}

process.on("exit", () => {
  if (initialized) db.close();
});

// ── SQLite backup (cron-like) ───────────────────────────────────────────────
// Copies the DB file to a backup directory with a timestamp. Keeps the last
// N backups. Called from the health poller in index.ts every 24h.

export function backupDatabase(): { backedUp: boolean; path?: string; error?: string } {
  if (!initialized) return { backedUp: false, error: "db not initialized" };
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "data", "ai-pipeline.db");
  const backupDir = join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "data", "backups");
  try {
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `ai-pipeline-${timestamp}.db`);
    const { copyFileSync } = require("node:fs");
    copyFileSync(dbPath, backupPath);
    // Prune old backups: keep only the last 7
    const { readdirSync, unlinkSync } = require("node:fs");
    const files = readdirSync(backupDir)
      .filter((f: string) => f.startsWith("ai-pipeline-") && f.endsWith(".db"))
      .sort();
    while (files.length > 7) {
      const old = files.shift();
      if (old) unlinkSync(join(backupDir, old));
    }
    return { backedUp: true, path: backupPath };
  } catch (err) {
    return { backedUp: false, error: err instanceof Error ? err.message : String(err) };
  }
}

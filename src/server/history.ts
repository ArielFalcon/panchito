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
import { RunRecord, RunMode, TestTarget, QaCase, RunVerdict, SpecRecord } from "../types";

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
      at TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_cases_run_id ON cases(run_id);
    CREATE INDEX IF NOT EXISTS idx_specs_run_id ON specs(run_id);
  `);

  insertRun = db.prepare(`
    INSERT INTO runs (id, app, sha, ref, target, mode, status, step, step_detail, verdict, passed, failed, note, retrying, parent_run_id, at, logs)
    VALUES (@id, @app, @sha, @ref, @target, @mode, @status, @step, @stepDetail, @verdict, @passed, @failed, @note, @retrying, @parentRunId, @at, @logs)
  `);
  getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  listRunsStmt = db.prepare("SELECT * FROM runs WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
  currentRunStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued') ORDER BY at DESC, rowid DESC LIMIT 1");
  interruptedStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued')");
  deleteCaseByName = db.prepare("DELETE FROM cases WHERE run_id = ? AND name = ?");
  insertCase = db.prepare("INSERT INTO cases (run_id, name, status, detail) VALUES (@runId, @name, @status, @detail)");
  getCasesStmt = db.prepare("SELECT * FROM cases WHERE run_id = ?");
  countCasesStmt = db.prepare("SELECT status, COUNT(*) AS cnt FROM cases WHERE run_id = ? GROUP BY status");
  getSpecsStmt = db.prepare("SELECT * FROM specs WHERE run_id = ?");
  appendLogStmt = db.prepare("UPDATE runs SET logs = logs || @log WHERE id = @id");

  // Prune old runs once on first use.
  db.prepare(`DELETE FROM runs WHERE at < datetime('now', '-${DELETE_MAX_AGE_DAYS} days')`).run();

  initialized = true;
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
    cases,
    specs: specRows.length > 0 ? specRows : undefined,
    logs: logsText ? logsText.split("\n").filter(Boolean) : [],
    at: row.at as string,
  };
}

export function createRecord(opts: {
  app: string; sha: string; ref?: string; target: TestTarget; mode: RunMode; parentRunId?: string;
}): RunRecord {
  ensureDb();
  const id = `run-${opts.sha.slice(0, 7)}-${Date.now().toString(36)}`;
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
  if (patch.step !== undefined) add("step", patch.step);
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

export function interruptedRecords(): RunRecord[] {
  ensureDb();
  const rows = interruptedStmt.all() as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function clearDatabase(): void {
  ensureDb();
  db.exec("DELETE FROM specs; DELETE FROM cases; DELETE FROM runs;");
}

process.on("exit", () => {
  if (initialized) db.close();
});

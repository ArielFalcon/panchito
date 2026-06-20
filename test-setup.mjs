// Per-test-process isolation for the history SQLite store.
//
// history.ts `ensureDb()` resolves the DB path as `HISTORY_DB_PATH ?? <root>/data/ai-pipeline.db`.
// With no override, EVERY test that touches the store writes to the same on-disk DB, which persists
// across runs. That accumulated state makes `npm test` non-deterministic (the reported test count
// drifts) and causes spurious failures: tests that do not mock `retrieveRules` (e.g. the
// "filtered-retry …" case in pipeline.test.ts) read rules seeded by earlier runs.
//
// This module is preloaded via `node --import ./test-setup.mjs` (see package.json `test` script), so
// it runs before any test imports history.ts. Node propagates `--import` to every test child process,
// so each test FILE gets its own fresh temp DB — `mkdtempSync` guarantees a unique dir per process.
// The dir is removed on process exit. `data/ai-pipeline.db` is never touched by the suite.
//
// Honors an explicit HISTORY_DB_PATH (e.g. set by CI) instead of overriding it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HISTORY_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "ai-pipeline-test-"));
  process.env.HISTORY_DB_PATH = join(dir, "history.db");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — a leftover temp dir is harmless and the OS reaps tmpdir anyway
    }
  });
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/run-history-port.adapter.ts
// Bridge: RunHistoryPort -> a REAL save(outcome). NO sibling adapter exists (grep-confirmed zero
// `implements RunHistoryPort` under qa-engine/src/) — per Task E.0's own instruction, this bridge IS
// the real implementation, inverting the legacy's leaky dynamic import() (pipeline.ts:487-619) into
// an explicit port rather than re-coupling to it. The legacy's own control-plane store
// (src/server/history.ts's saveRunOutcome, SQLite-backed) lives in src/ and is OFF LIMITS to import
// (qa-engine must not depend on src/) — no control-plane package exists under packages/ either
// (confirmed: only packages/sdk, unrelated). Per the plan's own fallback ("SQLite via the
// control-plane repo if present; otherwise a small in-memory/file store"), this ships the in-memory
// + file-backed pair; a SQLite-backed adapter can be swapped in later behind the SAME port with no
// caller change once a real control-plane store exists for qa-engine to own.
import { appendFileSync } from "node:fs";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunHistoryPort } from "../../application/ports/index.ts";

// Process-lifetime store — no persistence across restarts. Suitable for a single long-lived run
// process or for tests; the composition root should prefer FileRunHistoryAdapter (or a future
// SQLite adapter) whenever outcomes must survive a restart.
export class InMemoryRunHistoryAdapter implements RunHistoryPort {
  private readonly outcomes: RunOutcome[] = [];

  async save(outcome: RunOutcome): Promise<void> {
    this.outcomes.push(outcome);
  }

  // Read-back for callers that need the accumulated history (e.g. buildShadow's read-only snapshot,
  // Task E.2). Not part of the RunHistoryPort interface (save-only) — an adapter-specific extension.
  list(): readonly RunOutcome[] {
    return this.outcomes;
  }
}

// Durable append-only JSONL store — one outcome per line, survives process restarts. Errors from the
// underlying fs write propagate loudly (CLAUDE.md: never swallow an integration error).
export class FileRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly filePath: string) {}

  async save(outcome: RunOutcome): Promise<void> {
    appendFileSync(this.filePath, `${JSON.stringify(outcome)}\n`, "utf8");
  }
}

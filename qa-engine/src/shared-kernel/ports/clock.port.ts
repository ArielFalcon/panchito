// qa-engine/src/shared-kernel/ports/clock.port.ts
// Determinism seam for time. The legacy code calls Date.now()/new Date() inline, which makes
// outcomes non-reproducible and the characterization net flaky on `at` timestamps. The orchestrator
// reads time ONLY through this port; tests inject a fixed clock so RunOutcome.at is deterministic.

export interface ClockPort {
  nowMs(): number;        // epoch milliseconds
  nowIso(): string;       // ISO-8601, the format RunOutcome.at / RunRecord.at use
}

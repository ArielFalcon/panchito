// qa-engine/src/shared-kernel/run-outcome.ts
// The immutable record of a finished run — consumed from here by qa-run-orchestration AND
// cross-run-learning (neither depends on the other). Structurally COMPATIBLE with legacy
// src/types.ts RunOutcome in the legacy → kernel direction — but WITHOUT the forward edge:
// errorClass is `string | null` (the legacy ErrorClass string-literal union ⊆ string),
// usage is `unknown` (the real RunUsage stays in agent-runtime; §5.1 P3), and reflection
// is `unknown` (the real StructuredReflection stays in cross-run-learning). The kernel types
// are intentionally WIDE so any legacy value satisfies them. Do NOT import ErrorClass,
// RunUsage, or StructuredReflection from src/ — that re-introduces the kernel→downstream edge.

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";
import type { QaCase } from "./qa-case.ts";

// Wide kernel alias: string is a supertype of the legacy ErrorClass string-literal union,
// so legacy values always satisfy this type without importing from downstream contexts.
export type ErrorClass = string | null;

export interface RunOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  errorClass: ErrorClass;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    reviewerRationale?: string;
    reviewerApproved?: boolean;
    flaky: boolean;
    retries: number;
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    // Wide: the real type is agent-runtime's RunUsage; `unknown` keeps the kernel
    // free of downstream dependencies. Adapters narrow at their boundary.
    usage?: unknown;
    phaseTimings?: Record<string, number>;
    preExecAmbiguityCatches?: number;
    deterministicSelectorBlocks?: number;
    // Plan 7-R B5.2: Pillar-2 catalog-gate honest-coverage telemetry (mirrors legacy src/types.ts:
    // 267-269 exactly). Optional — absent means the gate never ran for this outcome (e.g. no
    // getByTestId selectors in the run's specs), never a fabricated 0. The characterization
    // comparator (equivalence.ts) already normalizes an absent value to 0 for behavioral comparison.
    catalogGateInWindow?: number;
    catalogGateAdvisory?: number;
    catalogGateFailClosed?: number;
  };
  rulesRetrieved: string[];
  // Wide: the real type is cross-run-learning's StructuredReflection; `unknown` for the same reason.
  reflection?: unknown;
  // Diagnostic note for a terminal exit (mirrors legacy src/types.ts's `note?: string` on RunOutcome /
  // AgentResult / QaRunResult): a human-readable reason surfaced to the run record — e.g. the InfraError
  // message from a deploy-gate/health failure, or "setup failed: <cause>". Optional; absent means no
  // diagnostic was captured for this outcome (never a fabricated empty string). src/server/runner.ts
  // maps `run.note || undefined` into the run record — this field is what makes that mapping non-empty
  // on the rewritten path.
  note?: string;
  at: string;
  // W3 F3 (HIGH, audit-verified cutover blocker): the run's per-case results — RunHistoryPort has no
  // read-back path (see rewritten-orchestrator.adapter.ts's own header), so a driving-side caller
  // with ONLY a RunOutcome (src/server/runner.ts's runViaRewrittenEngine) had no cases to thread
  // into history.addCase(), leaving every rewritten-engine run's passed/failed counts at 0/0 and its
  // case list empty regardless of the real Playwright/code-runner result. Optional — comparator-blind
  // by construction (equivalence.ts's behavioralProjection() reads only the fields it explicitly
  // names; cases is not one of them, so adding it cannot change golden-parity comparisons). Absent
  // only for outcomes that never reached execution (e.g. a skip/invalid/infra-error terminal that
  // never ran an ExecutionPort.execute() call) — never a fabricated empty array standing in for
  // "unknown", which is why this is `cases?` and not `cases: QaCase[] = []`.
  cases?: QaCase[];
  // W3 F3: a minimal log string for the run — RunOutcome carries no execution-log field at all
  // before this fix, so runViaRewrittenEngine's own `logs: ""` was not a bug in that function, it
  // was the ONLY value available at that boundary. Optional, same comparator-blind reasoning as
  // cases above. This is NOT a full log-streaming port (CLAUDE.md scope note: a dedicated
  // emitLog-shaped streaming port is a larger, separate concern — flagged, not built here); it is
  // the same one-shot "whatever ExecutionPort.execute() already returned" string legacy's own
  // QaRunResult.logs carries for a completed run.
  logs?: string;
}

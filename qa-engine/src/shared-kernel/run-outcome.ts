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
}

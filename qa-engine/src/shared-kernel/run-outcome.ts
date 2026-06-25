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
  };
  rulesRetrieved: string[];
  // Wide: the real type is cross-run-learning's StructuredReflection; `unknown` for the same reason.
  reflection?: unknown;
  at: string;
}

// qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
// The core's segregated ports. The DRIVING seam (RunPipelinePort) is the strangler; the driven ports
// are the 10 capability seams the Run lifecycle composes, plus ObserverPort (replaces the 7 positional
// callbacks) and RunHistoryPort (inverts the leaky dynamic import() at pipeline.ts:487-619).
// Interfaces only — adapters arrive in Plan 6. Every type is kernel-resident; no cross-context import.

import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunStep } from "@kernel/run-step.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Objective } from "@kernel/objective.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunEventBody } from "@kernel/run-event.ts";

// The immovable strangler seam: a single input → a RunOutcome. Both LegacyPipelineAdapter and the
// RewrittenOrchestratorAdapter satisfy this (Plan 6).
export interface RunInput {
  app: string;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
}
export interface RunPipelinePort {
  run(input: RunInput): Promise<RunOutcome>;
}

// ── Driven capability ports (one per orchestrated context) ────────────────────
export interface ChangeAnalysisPort {
  analyze(sha: Sha): Promise<BlastRadius>;
  classify(sha: Sha): Promise<{ action: "skip" | "regression" | "generate"; reason: string }>;
}
export interface GenerationPort {
  generate(objectives: readonly Objective[], specDir: string): Promise<{ specs: string[]; approved: boolean; note?: string }>;
}
export interface ReviewPort {
  review(specDir: string, cases: readonly QaCase[]): Promise<{ approved: boolean; corrections: string[]; rationale?: string }>;
}
export interface ValidationPort {
  validate(specDir: string): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>; // infra optional: mirrors src/qa/validate.ts CheckResult
}
export interface ExecutionPort {
  execute(specDir: string): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string }>;
}
export interface ObjectiveSignalPort {
  measure(br: BlastRadius, specDir: string): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null }>;
}
export interface PublicationPort {
  publish(decision: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string }): Promise<{ outcome: string }>;
}
export interface LearningPort {
  // Off-path by contract — a failure is logged and swallowed, never gates publish.
  fold(outcome: RunOutcome): Promise<void>;
  retrieve(sha: Sha): Promise<string[]>;
}
// DeployGatePort is a cross-cutting infra port; it is kernel-resident (Task 8) so neither context
// needs to import it from the other. Re-export it here so callers of this barrel get a single import.
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
export interface WorkspacePort {
  prepare(sha: Sha): Promise<{ specDir: string }>;
}
// Replaces the 7 positional callbacks (onStep/onCase/…) with one typed observer.
export interface ObserverPort {
  onStep(step: RunStep, detail?: string): void;
  onEvent(body: RunEventBody): void;
}
// Inverts the leaky dynamic import() into a port (pipeline.ts:487-619).
export interface RunHistoryPort {
  save(outcome: RunOutcome): Promise<void>;
}


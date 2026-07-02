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
  // signal is a SEPARATE transport arg (mirrors legacy runPipeline's own trailing signal
  // parameter), NOT a field on RunInput — the queue's cancellation is orthogonal to what run is
  // being requested. Plan 7.1 (engram #913): closes the rewritten cancellation gap — a cancelled
  // rewritten run must actually stop instead of resolving late and overwriting a finalized record.
  run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome>;
}

// ── Driven capability ports (one per orchestrated context) ────────────────────
export interface ChangeAnalysisPort {
  analyze(sha: Sha): Promise<BlastRadius>;
  // diff: the "dynamic diff" fix (engram #936) — classify() already fetches the commit's diff
  // internally (to feed classifyCommit); surfacing it here lets the caller thread the REAL per-run
  // diff into generation instead of a stale/empty static value. Only "diff" mode calls classify()
  // (CLAUDE.md "Run modes"), so this is the only source of a genuine per-run diff at this layer.
  classify(sha: Sha): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string }>;
}
export interface GenerationPort {
  // signal: Plan 7.1 (engram #913) — an optional, separate transport arg (mirrors RunPipelinePort's
  // own signal), threaded through so a cancelled run's in-flight generation can be interrupted
  // rather than resolving late. Wraps runE2E/runPipeline's own signal-aware generate() in
  // production; a port stub that ignores it is unaffected (backward compatible).
  //
  // diff: the "dynamic diff" fix (engram #936) — an optional, separate transport arg carrying the
  // RUN's actual commit diff (sourced from ChangeAnalysisPort.classify() in diff mode), threaded
  // through so generation gets real change context instead of a static composition-time value.
  // Absent (non-diff modes, which never classify) -> the adapter falls back to its own static
  // per-run diff, unaffected (backward compatible).
  generate(objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string): Promise<{ specs: string[]; approved: boolean; note?: string }>;
}
// ReviewPort is the authoritative publish gate's seam. blockingCount distinguishes blocking
// corrections (must regenerate) from advisory ones (may approve when only advisory remain);
// parsed is FALSE only on a parse miss (no verdict JSON could be parsed) — NOT a real rejection —
// so the FixLoop re-prompts once instead of burning a fix round. Both are carried from the legacy
// ReviewResult (src/integrations/opencode-client.ts) so the domain drops no behavior (the #1
// fail-closed invariant: parsed).
export interface ReviewPort {
  // diff: the run's REAL per-run commit diff (Plan 7.6 dynamic-diff), so the reviewer grounds on the
  // actual change — NOT a static composition-time value that is empty in production. Optional: absent
  // -> the adapter falls back to its static ctx.diff (the F.2 operator / unit-test path).
  review(specDir: string, cases: readonly QaCase[], diff?: string): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
  }>;
}
export interface ValidationPort {
  validate(specDir: string): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>; // infra optional: mirrors src/qa/validate.ts CheckResult
}
export interface ExecutionPort {
  // signal: Plan 7.1 (engram #913) — see GenerationPort's own signal note; wraps runE2E's existing
  // signal-aware execute() so a cancelled run's in-flight test execution can be interrupted.
  execute(specDir: string, signal?: AbortSignal): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string }>;
}
export interface ObjectiveSignalPort {
  // valueScore: the value-oracle (mutation-testing) result the legacy persists alongside
  // coverageRatio in gateSignals.valueScore (src/pipeline.ts:3267's persistOutcome call site;
  // src/qa/learning/labeler.ts's LabelerInput.valueScore). Optional/nullable so a stub or a
  // composition root that has not yet wired the mutation-testing oracle (Task E.0) can omit it —
  // absent is read as "not measured", never a fabricated 0.
  measure(br: BlastRadius, specDir: string): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null }>;
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


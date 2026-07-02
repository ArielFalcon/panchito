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
  // Cross-repo deploy-event semantics: set when this run was triggered by a webhook from a SERVICE
  // repo (a microservice whose commit deployed, not the primary app repo itself) — mirrors legacy
  // RunRequest.triggerRepo (src/server/runner.ts) / pipeline.ts's own `triggerService`. When set,
  // browser V8 coverage cannot map the service repo's changed lines, so change-coverage MUST stay
  // "unknown" (src/pipeline.ts:2912's `!triggerService` conjunct; CLAUDE.md: "Change-coverage is
  // unknown for these [cross-repo] runs"). Absent (the common case) -> ordinary monorepo run.
  triggerRepo?: string;
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
  //
  // diff: the "dynamic diff" precedent (GenerationPort.generate's own optional trailing `diff` arg,
  // above) — the run's REAL per-run commit diff (sourced from ChangeAnalysisPort.classify() in diff
  // mode, the only mode that ever measures change-coverage: CLAUDE.md "Run modes" + src/pipeline.ts's
  // own `mode === "diff"` coverage gate). Absent (every non-diff mode, or a caller that predates this
  // param) -> the adapter's assembler is never invoked -> decide() receives null -> "unknown" -> NEVER
  // blocks (the keystone's own architecturally-safe default, unchanged).
  measure(br: BlastRadius, specDir: string, diff?: string): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null }>;
}
export interface PublicationPort {
  // reviewerApproved/coverageBlocks/e2eChanged (audit fix, judgment-day): the REAL per-run values
  // RunQaUseCase already computes (reviewerApproved at the review phase; coverageBlocks at the
  // measure phase) — OPTIONAL so every pre-existing caller/stub/test that only ever passed
  // {verdict, cases, logs} keeps compiling and behaving identically. Absent -> the adapter falls
  // back to its static composition-time ctx (the F.2 operator / unit-test path), exactly the
  // dynamic-diff precedent (ReviewPort.review's own optional `diff` param, above). When PRESENT,
  // these override the static ctx so a green-but-reviewer-rejected run correctly routes to an Issue
  // instead of a PR, and an enforce-mode coverage failure correctly holds the PR — neither of which
  // the static ctx (fixed at composition-build time, before any run's real verdict exists) can ever
  // reflect on its own.
  publish(decision: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    logs: string;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
  }): Promise<{ outcome: string }>;
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

// SetupPort — CLAUDE.md's run-flow step 3 ("Setup — bootstrap the config/e2e seed into e2e/, then
// npm ci; runs BEFORE generation so the agent has the fixtures/config"), missing from this rewrite.
// Prepares specDir so the generator has fixtures/deps to build on: e2e bootstraps the seed (first
// run) + npm ci; code installs the repo's own deps. e2e-vs-code dispatch is the ADAPTER's concern
// (mirrors ExecutionPort's own target-dispatch split) — this port's own signature stays generic. A
// throw MUST propagate to the caller: the legacy treats a setup failure as infra-error, never a code
// verdict (src/qa/setup.ts's own doc: "the pipeline surfaces that as infra-error, never a code
// verdict"), and RunQaUseCase.run is the place that maps the throw to infraErrorResult().
export interface SetupPort {
  setup(specDir: string, signal?: AbortSignal): Promise<void>;
}


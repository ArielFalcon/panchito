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

// W2 fix (F5, CommitIntent threading): a structural mirror of generation's own CommitIntent
// (@contexts/generation/application/ports/generation-ports.ts) — NOT imported, per this barrel's
// own "no cross-context import" rule (every type here is kernel-resident). Mirrors the legacy's
// GenerateInput.intent/ReviewInput.intent shape (src/integrations/opencode-client.ts) exactly:
// type/breaking/message/body/changedFiles. A generation-context CommitIntent value is structurally
// assignable to this port-local shape (both are plain data), so no adapter-side remapping is
// needed beyond a type-level cast at the bridge boundary.
export interface CommitIntent {
  type: string;
  breaking: boolean;
  message: string; // first line (what the agent uses as intent)
  body?: string; // the commit message body (lines after the subject) — the richest statement of intent
  changedFiles: string[]; // the agent derives the scope/area from these
}

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
  //
  // intent: W2 fix (F5) — classifyCommit() ALREADY derives the full CommitIntent (type/breaking/
  // message/body/changedFiles) as part of computing action/reason (it returns a CommitClassification
  // extends CommitIntent), but the port previously discarded everything except {action, reason}.
  // Surfacing it here mirrors the diff fix's own precedent: the caller (RunQaUseCase) threads intent
  // into GenerationPort.generate()'s enrichment (diff-mode generation) and — where the legacy's own
  // reviewer objective derivation reads intent?.message (src/pipeline.ts:1682) — into review() too.
  // Optional: a stub/legacy caller that omits it is unaffected (matches every other optional field
  // this barrel has widened with — dynamic diff, signal, etc.).
  classify(sha: Sha): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent?: CommitIntent }>;
}
// W2 fix (F1, generation regen/enrichment context — audit-verified cutover blocker): the legacy's
// GenerateInput (src/integrations/opencode-client.ts's OpencodeRunInput) carries fixCases/
// reviewCorrections/selectorContradictions/domSnapshot/coverageGap/intent — the fields a regen or
// reviewer-correction round needs so the agent sees WHY it is being asked to try again. This barrel's
// GenerationPort.generate() had no slot for any of them, so every regen (the FixLoop's own retry,
// the reviewer-correction loop, F3) silently generated with the SAME contextless prompt as the
// initial attempt. Widened with ONE optional trailing object (not more positional args — the diff/
// signal precedent already set two; a 3rd/4th/5th positional arg would be unreadable at call sites)
// so every field is independently absent-safe: an adapter/stub that never reads `enrichment` is
// unaffected (backward compatible with every existing GenerationPort implementation/test).
export interface GenerationEnrichment {
  // Reviewer rejection corrections (F3) — mirrors the legacy's reviewCorrections: threaded into the
  // regen prompt's "Apply reviewer corrections HIGHEST priority" section (src/integrations/
  // prompts.ts:727-737).
  reviewCorrections?: string[];
  // FixLoop retry context (F2) — mirrors FixLoopGenerateInput's own fixCases/selectorContradictions/
  // domSnapshot (../../domain/fix-loop.aggregate.ts) so a fix-loop regen renders the legacy's "Fix
  // failing tests" section instead of a bare re-prompt.
  fixCases?: readonly QaCase[];
  selectorContradictions?: readonly string[];
  domSnapshot?: string;
  // Change-coverage enforce-mode regeneration (src/pipeline.ts's renderUncovered(cc) call site,
  // baseGenInput({ coverageGap: ... })) — the changed lines a green run failed to exercise.
  coverageGap?: string;
  // F5 — the run's CommitIntent (diff mode), threaded from ChangeAnalysisPort.classify() the same
  // way the dynamic diff already is, so diff-mode generation receives the SAME intent the legacy's
  // baseGenInput() forwards on every call (src/pipeline.ts:1678's `intent,`).
  intent?: CommitIntent;
  // Manifest-enrichment fix: the run's commit sha, needed to stamp OpencodeRunInput.sha so
  // GenerateTestsUseCase can populate ManifestEntry.changeRef.sha (the real manifest schema
  // requires changeRef.sha non-empty — src/orchestrator/schemas.ts ManifestEntrySchema). `sha` is
  // available on EVERY RunQaUseCaseInput regardless of mode (unlike diff/intent, which are
  // diff-mode-only via classify()) — callers should thread `input.sha.toString()` here on every
  // generate() call, the same way baseEnrichment already threads `intent`. NOT YET WIRED at the
  // run-qa.use-case.ts call sites (out of this change's scope — see GenerationPortAdapter.generate's
  // own comment for the adapter-side half of this fix); until wired, OpencodeRunInput.sha stays ""
  // and changeRef.sha fails the schema, exactly the live-run evidence this fix responds to.
  sha?: string;
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
  //
  // enrichment: W2 fix (F1) — see GenerationEnrichment's own header. Optional trailing object;
  // absent -> the adapter's OpencodeRunInput carries none of these fields, an unchanged prompt
  // (exactly today's behavior).
  generate(objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<{ specs: string[]; approved: boolean; note?: string }>;
}
// ReviewPort is the authoritative publish gate's seam. blockingCount distinguishes blocking
// corrections (must regenerate) from advisory ones (may approve when only advisory remain);
// parsed is FALSE only on a parse miss (no verdict JSON could be parsed) — NOT a real rejection —
// so the FixLoop re-prompts once instead of burning a fix round. Both are carried from the legacy
// ReviewResult (src/integrations/opencode-client.ts) so the domain drops no behavior (the #1
// fail-closed invariant: parsed).
// W2 fix (F3, reviewer-corrections regeneration loop): the legacy's reviewGenerated() threads the
// PRIOR round's own corrections into the NEXT review call (src/pipeline.ts:1682's
// `...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {})`) so the
// reviewer can judge CONVERGENCE — approve once the previously-raised BLOCKING issues are resolved,
// rather than inventing new nits on unchanged specs. Optional trailing object, same precedent as
// GenerationEnrichment (F1) — absent -> the adapter's ReviewInput carries none of these, unchanged
// prompt (today's behavior).
export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  // F5 — mirrors legacy's `objective: opts.guidance ?? intent?.message` (src/pipeline.ts:1682): when
  // no manual guidance exists, the reviewer's objective is derived from the commit intent's message.
  intent?: CommitIntent;
}
export interface ReviewPort {
  // diff: the run's REAL per-run commit diff (Plan 7.6 dynamic-diff), so the reviewer grounds on the
  // actual change — NOT a static composition-time value that is empty in production. Optional: absent
  // -> the adapter falls back to its static ctx.diff (the F.2 operator / unit-test path).
  //
  // enrichment: W2 fix (F3) — see ReviewEnrichment's own header. Optional trailing object; absent ->
  // the adapter's ReviewInput carries no priorCorrections/intent, unchanged prompt.
  review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
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
    // F3 (CRITICAL, cross-repo Issue routing): mirrors legacy's `issueRepo = triggerService ?
    // triggerService.repo : app.repo` (src/pipeline.ts:1021). OPTIONAL — absent falls back to the
    // adapter's static ctx.repo (every ordinary monorepo run), same precedent as the fields above.
    // PR creation always targets ctx.repo (the primary repo), regardless of this field.
    issueRepo?: string;
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


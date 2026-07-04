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
  // Audit CRITICAL (task #33): mirrors legacy's RunOptions.previousNamespace (src/types.ts) — see
  // CleanupPort's own header (below) and RunQaInput.previousNamespace's own doc
  // (run-qa.use-case.ts) for the full contract. Threaded straight through by
  // RewrittenOrchestratorAdapter.run(input) into RunQaUseCase.run(input) unchanged (this type is
  // structurally what RunQaInput expects — see that adapter's own header on why no remapping is
  // needed beyond a type-level cast).
  previousNamespace?: string;
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
  // W5 fix (seam-parity FIXME, runId threading half): the run's id (RunInput.runId, this barrel,
  // above), mirrors legacy's OpencodeRunInput.runId — opencode-client.ts uses it for the SSE session
  // descriptor (registerRunSession/appendLog telemetry) so a generator session appears in live run
  // activity/telemetry. Threaded here (not the static per-run context) because it is a genuinely
  // PER-RUN value, the same "dynamic" precedent `sha`/`intent` above already establish. Absent ->
  // OpencodeRunInput.runId stays unset, unchanged (today's behavior).
  runId?: string;
  // W3 F2 (cross-run learning retrieval): the structured rules LearningPort.retrieve(sha) returned
  // (the port's OWN established contract — RetrievedRule, widened per W3 F1 above) — mirrors
  // legacy's own retrieval injection (src/pipeline.ts's `learnedRules` local, baseGenInput({
  // learnedRules, ... }) at pipeline.ts:1899). The adapter boundary (GenerationPortAdapter) renders
  // this array into the SAME OpencodeRunInput.learnedRules string field buildPromptAssembled
  // already renders a section for, using the SAME proven/experimental split legacy's own
  // renderRulesForPrompt applies (src/qa/learning/learning-rule.ts:237-278) — format decisions
  // belong at that boundary, matching every other enrichment field's own 1:1-at-the-adapter
  // mapping. Absent/empty -> unchanged prompt (retrieval found nothing, or the app's
  // LearningRepositoryPort is the StubLearningRepository no-op default).
  learnedRules?: readonly RetrievedRule[];
  // W4 (Plan 7-R, selector-grounding cutover): the PRE-generate grounding data — mirrors legacy's
  // baseGenInput({ contextPack: builtContextPack, existingSpecFiles, ... }) (src/pipeline.ts:1898,
  // 1908). Unlike domSnapshot above (which is REGEN-time grounding, sourced from a failure-point or
  // pre-review capture), these two are FIRST-WRITE grounding: built ONCE before the initial
  // generate() call (PreGenerationGroundingPort, below) and reused unchanged across every
  // regeneration in the SAME run (mirrors legacy's own "the pack is first-write ground truth; fix/
  // review/coverage passes use domSnapshot instead" comment, pipeline.ts:1820-1822). Absent -> the
  // generator falls back to its own live-MCP exploration (today's rewritten-engine behavior,
  // unchanged) — never fabricated, never required.
  //
  // contextPack: the assembled blast-radius + DOM + contracts text block (generation/infrastructure's
  // ContextPackAssembly.text, buildContextPack) — pushed into the VOLATILE "context-pack" prompt
  // section buildPromptAssembled already renders (OpencodeRunInput.contextPack's own doc).
  contextPack?: string;
  // existingSpecFiles: the suite's on-disk spec file paths (relative to e2eRelDir), enumerated
  // BEFORE the first generate() call so the "existing-suite-manifest" prompt section lets the
  // generator reuse/extend instead of duplicating a flow (mirrors legacy's Seam b,
  // src/pipeline.ts:1845-1872 + OpencodeRunInput.existingSpecFiles's own doc).
  existingSpecFiles?: string[];
  // CodeGraph Phase 4 (design §5.1, ADR-3): the rendered advisory "structural blast radius" block
  // (blast-radius-signal.ts's renderBlastRadiusSignal output) — mirrors legacy's OpencodeRunInput.
  // staticSignal (generation-ports.ts:137), which prompts.ts already renders a section for in
  // generation mode. Filled by RunQaUseCase from the OPTIONAL StructuralSignalPort collaborator
  // (below); absent -> no section, byte-identical to today (the field was previously listed in
  // seam-parity.contract.test.ts's ALLOWLIST as a confirmed drop — this closes that gap). Advisory
  // ONLY: this string reaches the generation prompt and NOTHING else — no verdict/gate/coverage
  // path reads it (ADR-2).
  staticSignal?: string;
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
  // W3 F2 (cross-run learning retrieval): mirrors legacy's `learnedRules: renderRulesForReviewer(
  // retrievedRules)` (src/pipeline.ts:1679) — the SAME retrieved structured rules the generator's
  // prompt received (LearningPort.retrieve(sha)'s own established RetrievedRule[] contract),
  // rendered at the adapter boundary — using ONLY active rules, exactly legacy's
  // renderRulesForReviewer (src/qa/learning/learning-rule.ts:299-313; candidates are for the
  // generator to explore, never for the judge to gate on) — for the reviewer's "app-specific
  // reject-on-sight rules" section so the independent reviewer judges against the SAME earned
  // rules the generator was grounded on. Absent/empty -> unchanged prompt (today's behavior).
  learnedRules?: readonly RetrievedRule[];
  // W4 (Plan 7-R, selector-grounding cutover): the live DEV a11y snapshot of the routes the specs
  // under review target — mirrors legacy's reviewGenerated() captureDom call (src/pipeline.ts:1643-
  // 1649's `domSnapshot = await deps.captureDom(...).catch(() => undefined)`), grounding the
  // independent reviewer's UI-fact claims (labels, button/link text) in the real DOM instead of its
  // training memory (the SAME anti-hallucination rationale ReviewInput.domSnapshot's own doc states
  // — "it claimed PetClinic's submit button says 'Add Owner' when the live DOM says 'Submit'").
  // Absent -> the reviewer defers on unverifiable UI facts (today's behavior, unchanged).
  domSnapshot?: string;
  // W5 fix (seam-parity FIXME, runId threading half): mirrors GenerationEnrichment.runId's own doc
  // above — opencode-client.ts uses input.runId for the reviewer session's OWN SSE descriptor too
  // (a SEPARATE session from the generator's). Absent -> ReviewInput.runId stays unset, unchanged.
  runId?: string;
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
// W4 fix (F1, audit-verified cutover blocker): the legacy's execute() opts (src/qa/execute.ts
// ExecuteOptions, threaded through pipeline.ts's own runE2E/runCodeTests call sites) carry
// faultInject/specFiles/project/timeoutMs/onCase/onRunning/onDiscovered — E2eExecutionStrategy
// (test-execution/infrastructure/e2e-execution.strategy.ts) already forwards every one of these
// into ExecutionRequest, but THIS port previously exposed only `signal` as a 2nd positional arg,
// so every capability past signal was structurally unreachable at the orchestration layer no
// matter what the strategy supported underneath. Widened with ONE optional opts bag — the SAME
// "enrichment object" precedent GenerationEnrichment/ReviewEnrichment already established (no
// further positional creep) — so each field is independently absent-safe.
//
// Backward compat: `opts` accepts EITHER the bag OR a bare AbortSignal (the pre-existing 2nd
// positional arg shape) so every caller/stub/test written against `execute(specDir, signal?)`
// keeps compiling and behaving identically — a bare AbortSignal is normalized to `{ signal }`
// internally by the adapter (see execution-port.adapter.ts). Distinguishing the two shapes needs
// no runtime type-check ambiguity: AbortSignal is a class instance (has `.aborted`/`.addEventListener`),
// the opts bag is a plain object literal — callers pass one or the other, never both.
export interface ExecutionOpts {
  signal?: AbortSignal;
  faultInject?: boolean;
  // Filtered-retry (F1a): scope a re-execution to ONLY the specs that failed (mirrors legacy's
  // `canFilter ? { specFiles: failedSpecFiles } : {}`, src/pipeline.ts's own filtered-retry gate) —
  // the FixLoop aggregate (domain/fix-loop.aggregate.ts) already computes canFilter/failedSpecFiles
  // on its OWN local FixLoopExecutionPort; this field is what lets the use-case-level wiring thread
  // that decision through to the REAL strategy instead of dropping it on the floor.
  specFiles?: string[];
  project?: string;
  timeoutMs?: number;
  // Live per-case/per-test progress (F1b): mirrors ExecutionRequest's own onCase/onRunning/
  // onDiscovered (test-execution/application/ports/index.ts) — threading these through lets a
  // caller emit ObserverPort.onEvent("test.started"/"test.passed"/"test.failed"/"test.discovered")
  // DURING execution instead of only reconstructing them post-hoc from the final case list.
  onCase?: (c: QaCase) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
}
export interface ExecutionPort {
  // signal: Plan 7.1 (engram #913) — see GenerationPort's own signal note; wraps runE2E's existing
  // signal-aware execute() so a cancelled run's in-flight test execution can be interrupted.
  //
  // opts: W4 fix (F1) — see ExecutionOpts's own header above. A bare AbortSignal (the pre-existing
  // shape) or the richer opts bag; absent -> no capability beyond specDir (unchanged default).
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string }>;
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
  //
  // baselineCases: W4 fix (F2, audit-verified cutover blocker — "the dead value oracle"). The
  // e2e fault-injection oracle (ValueOraclePort.measure's own baselineCases param,
  // objective-signal/application/ports/index.ts) returns valueScore:null FOREVER unless it is
  // told which specs are the green baseline to inject faults against — the legacy computes this
  // PER RUN, post-execution, from the just-executed run's own passing case names
  // (src/pipeline.ts:731's `run.cases.filter(c=>c.status==="pass").map(c=>c.name)`). The
  // composition root previously had no per-run value to supply here (rewritten-engine-factory.ts's
  // own `baselineCases: []` is a STATIC, composition-time placeholder — always empty, since no
  // per-run case list exists yet when CompositionConfig is built) — every rewritten-engine run's
  // valueScore was silently null. Same "dynamic diff" precedent as the `diff` param immediately
  // above: an OPTIONAL trailing arg, threaded from RunQaUseCase's own just-executed `run.cases` at
  // the measure() call site. Absent -> the adapter falls back to its static ctx.baselineCases
  // (backward compatible with every pre-existing caller/stub/test).
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[]): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null }>;
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
// W3 fix (F1, dual-judge round): LearningPort.retrieve() previously returned bare trigger strings
// (readonly string[]), which starved BOTH prompt renderers of the fields legacy's own LearningRule
// shape carries and legacy's renderRulesForPrompt/renderRulesForReviewer actually render (src/qa/
// learning/learning-rule.ts:15-32,237-313) — action, errorClass, status (proven vs experimental),
// and confidence. The minimal FAITHFUL widening: the fields BOTH legacy renderers consume, and
// nothing else (no successRate/usageCount/archetype/etc. — those stay internal to
// cross-run-learning's own LearningRule; this is a PORT-BOUNDARY projection, not a re-export of the
// full internal shape). `status` is narrowed to the two render-relevant buckets ("active" |
// "candidate") because deprecated/superseded rules are never retrieved (RuleGovernanceService.
// topRules's own RETRIEVABLE gate) — a widened union here would let callers handle branches that
// can structurally never occur.
export interface RetrievedRule {
  trigger: string;
  action: string;
  errorClass: string;
  status: "active" | "candidate";
  confidence: "low" | "medium" | "high";
}
export interface LearningPort {
  // Off-path by contract — a failure is logged and swallowed, never gates publish.
  fold(outcome: RunOutcome): Promise<void>;
  retrieve(sha: Sha): Promise<RetrievedRule[]>;
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

// CleanupPort — audit CRITICAL (task #33): orphan test-data cleanup, missing from this rewrite
// entirely until now. Mirrors legacy's src/pipeline.ts:1450-1458 EXACTLY:
//
//   if (opts.previousNamespace && !isCode && app.dev?.baseUrl) {
//     await deps.cleanup(e2eDir, { baseUrl: app.dev.baseUrl, namespace: opts.previousNamespace, testIdAttribute })
//       .catch((err) => { log(`cleanup warning (non-blocking): ${err.message}`); });
//   }
//
// WHEN legacy cleans (verified against src/pipeline.ts + src/server/runner.ts's own
// enqueueTrackedRun): NOT every run. Only when a PREVIOUS run's namespace is known to carry
// possibly-orphaned data — src/server/runner.ts:313-324 computes `previousNamespace` from the
// immediately-prior run RECORD (via testDataNamespace(prefix, prev.sha, prev.id)) ONLY when that
// prior run's own status was "running"/"enqueued" (i.e. it never reached a terminal state — a
// crash/SIGKILL/docker-restart interrupted it mid-flight) OR its verdict was "infra-error". A
// prior run that finished cleanly (pass/fail/flaky/invalid/skipped) leaves previousNamespace
// undefined -> cleanup is skipped entirely for that run (its own in-suite `cleanup` fixture,
// config/e2e/fixtures.ts, already tore down its own data on every attempt — there is nothing
// orphaned to sweep). This runs BEFORE this run's OWN generation/execution begins (legacy step
// "4a", strictly before the context-map load) — it cleans the PRIOR interrupted run's leftover
// data, not this run's own. e2e-only (isCode has no web test data) and requires app.dev.baseUrl
// (no live DEV target to clean against otherwise).
//
// WHAT cleanup does (src/qa/execute.ts's runCleanup/defaultCleanupDeps): spawns ONLY
// `cleanup.spec.ts` (a dedicated seed spec, config/e2e/cleanup.spec.ts) with PW_CLEANUP=1 and
// PW_NAMESPACE=<the interrupted run's BASE prefix, no per-attempt -w<worker>r<retry> suffix> —
// every OTHER spec in the suite self-skips via `test.skip(!process.env.PW_CLEANUP, ...)`, so this
// is a narrowly-scoped single-spec pass, not a full suite re-run. The seed's own contract: delete
// every entity whose name starts with the base PREFIX (covers every worker/retry the interrupted
// run used), and be IDEMPOTENT (no entities -> pass).
//
// FAILURE SEMANTICS (best-effort, VERIFIED against both layers): defaultCleanupDeps.runCleanup
// itself NEVER rejects — its Promise executor only ever calls resolve(), even on a spawn error, a
// non-zero exit, or a timeout-triggered kill (DEFAULT_CLEANUP_TIMEOUT_MS = 5 min; a timeout kills
// the process TREE via killTree() and still resolves). The pipeline call site ALSO wraps the call
// in `.catch((err) => log(...))` as a second, redundant safety net. A cleanup failure of ANY kind
// (spawn error, non-zero exit, timeout) is logged as a non-blocking warning and MUST NEVER alter
// this run's verdict, block generation, or propagate — orphan data is reaped by a LATER run's own
// cleanup pass if this one fails.
//
// [SWAP] absent -> the phase is a no-op, the SAME backward-compatible posture SetupPort/
// PreExecGroundingPort/PreGenerationGroundingPort already established — no orphan-data cleanup
// runs, never fabricated, never blocking (matches legacy's own `opts.previousNamespace` absent
// case exactly, which also skips the call entirely).
//
// baseUrl/testIdAttribute are DELIBERATELY absent from this signature — mirrors SetupPort's own
// "e2e-vs-code dispatch is the ADAPTER's concern... this port's own signature stays generic"
// precedent immediately above: RunQaUseCase has no baseUrl of its own anywhere in its body (every
// other port that needs it — ExecutionPort, GenerationPort's adapter — resolves it from its OWN
// static per-run composition context, the "adapter resolves its own paths" precedent
// PreExecGroundingPort/ExecutionPort already use). A real adapter (the bridge) is constructed with
// baseUrl/testIdAttribute as STATIC per-run context (matching ExecutionPortAdapter/
// SetupPortAdapter's own constructor shape) and reads them from there, not from this call.
export interface CleanupPort {
  cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void>;
}

// PreExecGroundingPort — Plan 7-R B5.3: the capture half of the pre-execution grounding gate.
// Reads the CURRENT on-disk specs at specDir and captures the live DOM of the routes they target,
// returning BOTH — mirrors legacy's capturePreExecSnaps EXACTLY (src/pipeline.ts:1943-1952, which
// returns `{ specSources, snaps }` for the SAME reason: the domain-service ambiguity/catalog checks
// need the spec TEXT to extract selectors from, not just the captured trees). Re-reading specSources
// off disk on EVERY call (never cached) means a re-invocation after a corrective regen sees the
// REWRITTEN specs, never a stale capture — required for the W2 persisting-ambiguity re-check to be
// meaningful. Routes are returned in the domain service's own RouteTree shape
// (pre-exec-grounding.service.ts) — kept structurally LOCAL here (not importing the domain type) so
// this barrel's "every type is kernel-resident, no cross-context import" rule holds; RouteTree's
// shape is duck-typed identical on purpose. [SWAP] absent -> RunQaUseCase's pre-exec grounding gate
// is skipped entirely (the SAME backward-compatible posture DeployGatePort/SetupPort/ObserverPort
// already established) — preExecAmbiguityCatches/deterministicSelectorBlocks/catalogGate* all stay
// the literal 0 they were before this port existed, never fabricated. A real adapter (Task E.0/
// Slice E) wraps generation/infrastructure's captureRouteTrees + buildRouteCatalog, reading the
// app's baseUrl/testIdAttribute from its own composition-time config (this port's signature stays
// generic — specDir is enough for the adapter to find + read the on-disk specs itself, the same
// "adapter resolves its own paths" precedent SetupPort/ExecutionPort already use).
export interface PreExecGroundingPort {
  capture(specDir: string, signal?: AbortSignal): Promise<{
    specSources: string[];
    routes: {
      route: string;
      nodes: string[];
      status?: "captured" | "degraded";
      settled?: boolean;
      testIds?: Map<string, number>;
    }[];
  }>;
}

// PreGenerationGroundingPort — Plan 7-R W4 (audit CRITICAL): the FIRST-WRITE grounding phase, run
// AFTER setup and BEFORE the initial generate() call — mirrors legacy's ordering EXACTLY (the
// explorer pass + buildContextPack block sits at src/pipeline.ts:2078-2138, strictly between
// baseGenInput's declaration and the first `generateOnce(baseGenInput(...))` call at :2164). Builds
// the Pillar-1/Pillar-2 selector-grounding data (DOM tree, route catalog, context pack) the
// GENERATION prompt needs so the agent transcribes real selectors instead of grounding via its own
// live-MCP exploration alone — closing the audit gap where a live jhipster run used getByRole()
// where the diff carried data-cy="shopNowMenu" because the prompt received NO DOM/route/context-pack
// data at all.
//
// Distinct from PreExecGroundingPort (above): that port is a POST-generate corrective gate (W1/W2 —
// re-checks the ALREADY-WRITTEN specs for ambiguity/fabricated test-ids). This port is a PRE-generate
// enrichment source (mirrors legacy's explorer+buildContextPack closure) — it runs ONCE per run,
// before ANY spec exists, and its output is threaded into GenerationEnrichment.contextPack /
// .existingSpecFiles for the ENTIRE run (never rebuilt on regen passes — "the pack is first-write
// ground truth", pipeline.ts:1820-1822). Distinct ALSO from ReviewDomGroundingPort (below): the
// reviewer's DOM snapshot is keyed on the GENERATED specs' routes (they don't exist yet at this
// phase) and captured fresh at review time, mirroring legacy's reviewGenerated() capture exactly —
// it is NOT part of this port's output.
//
// [SWAP] absent -> the whole phase is skipped entirely, the SAME backward-compatible posture
// DeployGatePort/SetupPort/PreExecGroundingPort already established: GenerationEnrichment.contextPack/
// existingSpecFiles stay absent, and generation degrades to its own live-MCP exploration — never a
// broken run, never fabricated data.
//
// Failures are non-fatal by design (mirrors legacy's own fail-open posture EXACTLY): buildContextPack's
// own call site wraps the WHOLE build in try/catch and logs a non-blocking warning on failure
// (pipeline.ts:2135-2137's `context-pack: build FAILED (non-blocking)`); the explorer pass is
// independently best-effort (pipeline.ts:2099-2101's own try/catch + warning). A real adapter
// reproduces this: it must NEVER throw — a capture/build failure degrades to an absent field on
// GroundingResult, loudly logged by the adapter itself, and RunQaUseCase proceeds with ungrounded
// generation exactly as if the port were absent.
export interface GroundingResult {
  // The assembled context-pack text block (blast-radius + DOM + contracts) — feeds
  // GenerationEnrichment.contextPack. Absent when the pack build failed or produced nothing.
  contextPack?: string;
  // The suite's on-disk spec file paths (relative to e2eRelDir), enumerated before the first
  // generate() call — feeds GenerationEnrichment.existingSpecFiles. Absent/empty when the e2e dir
  // does not exist yet or enumeration failed (mirrors legacy's Seam b try/catch, pipeline.ts:1845-
  // 1872 — graceful, never blocks).
  existingSpecFiles?: string[];
}
export interface PreGenerationGroundingPort {
  ground(specDir: string, signal?: AbortSignal): Promise<GroundingResult>;
}

// ReviewDomGroundingPort — Plan 7-R W4: the reviewer's live-DEV-DOM grounding, mirroring legacy's
// reviewGenerated() captureDom call EXACTLY (src/pipeline.ts:1643-1649's `if (!isCode && deps.
// captureDom && app.dev?.baseUrl) { ... domSnapshot = await deps.captureDom(...).catch(() =>
// undefined); }`). Distinct from PreGenerationGroundingPort (above): this is keyed on the
// JUST-GENERATED specs' own `.goto(...)` routes (they do not exist before generate() runs), so it is
// invoked at the review call site, not the pre-generate phase.
//
// specs are the relative spec file names under review (mirrors ReviewPort.review()'s own `cases`-
// derived specs list) — the adapter re-reads their CURRENT on-disk content itself (the same
// "adapter resolves its own paths" precedent PreExecGroundingPort.capture(specDir, ...) already
// established), so the caller never needs the file text. The caller re-invokes this per round
// (mirrors legacy's own per-round memoization keyed on the sorted spec-name set, reviewGenerated()'s
// `specsKey`/`lastSpecsKey`) so a regenerated spec set is re-captured, never stale.
//
// [SWAP] absent -> ReviewEnrichment.domSnapshot stays absent every round; the reviewer defers on
// unverifiable UI facts (today's behavior, unchanged) — never fabricated, never blocking.
//
// Failure is non-fatal by design (mirrors legacy's `.catch(() => undefined)` exactly): a real adapter
// must NEVER throw — capture failure degrades to `undefined`, loudly logged by the adapter itself
// (dom-snapshot.ts's captureDom already does this internally), and review proceeds ungrounded.
export interface ReviewDomGroundingPort {
  capture(specDir: string, specs: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
}

// StructuralSignalPort — CodeGraph Phase 4 (design §5.3, ADR-2, ADR-7): the ADVISORY blast-radius
// bridge. Composes CodeGraphPort's impactedSymbols/coChangeCoupling/callersOf against the run's REAL
// changed-file set and renders ONE markdown block for GenerationEnrichment.staticSignal (above).
// This is a thin ORCHESTRATION-layer port (not the kernel CodeGraphPort itself) so qa-run-orchestration
// stays free of any direct codebase-memory/CLI dependency — the real adapter
// (StructuralSignalPortAdapter, infrastructure/bridges/) composes the kernel port + the pure renderer.
//
// [SWAP] absent -> RunQaUseCase never assembles staticSignal; baseEnrichment carries no such field,
// byte-identical to today (the SAME backward-compatible posture setup/preGenerationGrounding/
// reviewDomGrounding already established). When present, invoked ONCE per run, before the first
// generate() call, with the run's REAL BlastRadius (built from classificationIntent.changedFiles —
// CRITICAL-1, design §5.4/ADR-7). A throw here is wrapped best-effort by the caller (mirrors
// preGenerationGrounding's own fail-open posture) — this port's own contract never surfaces an error
// past render(); an unavailable/failed query degrades to "" (no section), never a fabricated claim.
export interface StructuralSignalPort {
  render(repoDir: string, changed: BlastRadius): Promise<string>;
}


// qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts
// RunQaUseCase (design §5.3(1)) — the structural replacement for runPipeline's 2400-line body. Drives the
// Run lifecycle ENTIRELY through the 11 segregated ports: no inline IO, no prompt strings, no learning
// side-effects on the verdict path. The agent's no-op decision (approved + zero specs) is a VALID skipped,
// never invalid (CLAUDE.md invariant). The keystone (ObjectiveSignalPort: unknown NEVER blocks) is consumed
// here, never re-implemented. gateSignals.preExecAmbiguityCatches / deterministicSelectorBlocks are
// emitted as the NUMBER 0 (not undefined) when W1/W2 is unwired — pins the comparator's silent-mismatch hole.
//
// Phase order (legacy, verbatim): gate (DeployGatePort) -> prepare (WorkspacePort) -> classify
// (ChangeAnalysisPort; diff mode only -> skip short-circuit) -> generate (GenerationPort) -> validate
// (ValidationPort) -> health -> execute (ExecutionPort) -> FixLoop (Task D.4, standalone aggregate) ->
// measure (ObjectiveSignalPort, the keystone) -> review (ReviewPort) -> decide (RunDecisionService) ->
// publish (PublicationPort) -> persist (RunHistoryPort) -> fold (LearningPort, off-path).
//
// NOTE on scope (explicit, per Task D.5's own boundary): this composition wires the phases with the
// SAME stub-shaped ports the characterization scenarios (test/characterization/scenarios.ts) exercise
// for the legacy adapter, so the 10-scenario parity is a genuine apples-to-apples pin. It does NOT
// build the 11 bridge/facade adapters (Task E.0) or the PIPELINE_ENGINE composition root (Slice E) —
// those wire REAL adapters into these SAME ports later; the use-case logic here does not change.
//
// FixLoop wiring: this composition supplies a MINIMAL FixLoopExecutionPort/FixLoopGenerationPort/
// FixLoopSelectorCheckPort adapting the SAME GenerationPort/ExecutionPort instances the use-case
// already holds (their shapes are richer per fix-loop.aggregate.ts's own header — this use-case is
// exactly the place that header names as the reconciliation point). devHealthy() is derived from
// DeployGatePort.waitUntilServing (design §5(5): "devHealthy() is lifted out of the decision point
// into evidence assembly") — absent DeployGatePort (static sites/code target) defaults to always-healthy.

import { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunMode, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { isOk } from "@kernel/result.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import type {
  ChangeAnalysisPort,
  GenerationPort,
  ReviewPort,
  ValidationPort,
  ExecutionPort,
  ObjectiveSignalPort,
  PublicationPort,
  LearningPort,
  WorkspacePort,
  DeployGatePort,
  RunHistoryPort,
  SetupPort,
  CleanupPort,
  ObserverPort,
  CommitIntent,
  PreExecGroundingPort,
  PreGenerationGroundingPort,
  ReviewDomGroundingPort,
  RetrievedRule,
  StructuralSignalPort,
  ServiceLinksPort,
  ServiceLink,
  ContractDrift,
  CrossRepoImpactPort,
  CrossRepoImpact,
} from "./ports/index.ts";
import { decide, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import type { AdjudicatorVerdict } from "../domain/adjudicate.service.ts";
import { checkSpecSelectors } from "../domain/helpers/selector-check.ts";
import { resolveErrorClass } from "../domain/helpers/error-class.ts";
import { shouldDistillLearning } from "../domain/helpers/should-distill-learning.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";
import { checkPreExecGrounding, checkPersistingAmbiguity } from "../domain/pre-exec-grounding.service.ts";
// reflector-rewire (design ADR-5): ReflectorPort/ReflectionInput are declared in cross-run-learning
// (co-located with StructuredReflection/LearningRepositoryPort), not in this context's own ports
// barrel — same cross-context import precedent as LearningRepositoryPort (composition-root.ts /
// learning-port.adapter.ts already import from @contexts/cross-run-learning/application/ports).
import type { ReflectorPort, ReflectionInput } from "@contexts/cross-run-learning/application/ports/index.ts";

// FIX B (judgment-day, HIGH)'s own value: the change-coverage minRatio default (src/qa/
// change-coverage.ts's DEFAULT_COVERAGE_POLICY.minRatio) — needed here too so the FIX 4 errorClass
// derivation (E-COVERAGE-GAP band) uses the SAME threshold the legacy's labelRunOutcome() reads
// (app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio at src/pipeline.ts:1111).
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

// FIX 3 (judgment-day D.7 batch 2): the static-gate (Filter B) repair-round bound, verbatim from
// src/pipeline.ts:804's `const MAX_STATIC_FIX_ROUNDS = 2;` — the SAME constant, not an invented
// policy, gating the static-fix loop this use-case's validate phase now ports.
const MAX_STATIC_FIX_ROUNDS = 2;

// WS4 (full-flow remediation, 4.3): bounds the static-gate validation-error text threaded into the
// static-fix repair regen's fixCases enrichment (below) — a raw tsc/eslint error dump can run
// unboundedly long; this cap keeps the prompt payload sane, matching every other prompt-facing cap
// in this codebase (e.g. renderCoverageGap's own `max` slice, objective-signal/domain/
// render-coverage-gap.ts).
const STATIC_GATE_ERROR_DETAIL_MAX_CHARS = 4000;

// WS4 (full-flow remediation, 4.1): builds the prompt-side "failure-point DOM" snapshot threaded
// into FixLoopInput.failureDomSnapshot — a small, LOCAL renderer (this use-case's own concern, not a
// shared domain helper) mirroring the deleted legacy's buildFailureDom (src/pipeline.ts, removed at
// cutover 1228ea7): one "### <case name>" header per failing case that carries a failureDom,
// followed by that case's captured a11y tree lines verbatim. Distinct from fix-loop.aggregate.ts's
// OWN buildFailureDomLines (which splits a SINGLE case's failureDom into lines for Lever-2's
// per-case check) — this renders potentially MULTIPLE cases into ONE prompt-facing block. Pure;
// returns undefined when no failing case carries a failureDom (matches the aggregate's own
// "absent when no failed case carries a failureDom" doc on FixLoopInput.failureDomSnapshot).
function buildFailureDomSnapshot(cases: readonly QaCase[]): string | undefined {
  const parts: string[] = [];
  for (const c of cases) {
    if (c.status !== "fail" || !c.failureDom) continue;
    const lines = c.failureDom.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    parts.push(`### ${c.name}\n${lines.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// Config the use-case reads (kept minimal and explicit — the full AppConfig shape is a src/
// concern; the composition root (Slice E) narrows the real config to this input, matching the
// same discipline the domain VOs already use for their own inputs).
export interface RunQaConfig {
  needsReview: boolean;
  shadow: boolean;
  onFailure: string;
  maxRetries: number;
  isCode: boolean;
  // FIX B (judgment-day, HIGH): the change-coverage policy mode (src/qa/change-coverage.ts's
  // ChangeCoveragePolicy.mode). "signal" (the default) measures + records the keystone but NEVER
  // blocks publish; only "enforce" holds the PR on a "fail" status (CLAUDE.md "The value/trust
  // risk"; src/qa/change-coverage.ts:179-181's blocksPublish(): `policy.mode === "enforce" &&
  // status === "fail"`). "off" never even reaches a fail status in the legacy (decideCoverage is
  // skipped when the policy is off), but is accepted here too for completeness.
  coveragePolicyMode: "off" | "signal" | "enforce";
}

export interface RunQaUseCaseDeps {
  changeAnalysis: ChangeAnalysisPort;
  generation: GenerationPort;
  review: ReviewPort;
  validation: ValidationPort;
  execution: ExecutionPort;
  objectiveSignal: ObjectiveSignalPort;
  publication: PublicationPort;
  learning: LearningPort;
  workspace: WorkspacePort;
  deployGate?: DeployGatePort; // [SWAP] absent for static sites and the code target
  runHistory: RunHistoryPort;
  // [SWAP] absent -> the setup phase is skipped entirely (backward compatible with every
  // pre-existing composition that has not wired a SetupPort yet). CLAUDE.md run-flow step 3:
  // "Setup — bootstrap the config/e2e seed into e2e/, then npm ci; runs BEFORE generation so the
  // agent has the fixtures/config" — a throw from setup() propagates to infraErrorResult(), never a
  // code verdict (src/qa/setup.ts's own doc).
  setup?: SetupPort;
  // [SWAP] absent -> the cleanup phase is skipped entirely (backward compatible with every
  // pre-existing composition that has not wired a CleanupPort yet) — the SAME posture as setup
  // above. Audit CRITICAL (task #33): orphan test-data cleanup, mirrors legacy's
  // src/pipeline.ts:1450-1458 EXACTLY — see CleanupPort's own header (ports/index.ts) for the full
  // "when does legacy clean" contract (only when input.previousNamespace is set, i.e. the run
  // immediately prior to this one was interrupted or ended infra-error) and failure semantics
  // (best-effort: a cleanup failure is logged and MUST NEVER alter this run's verdict).
  cleanup?: CleanupPort;
  // [SWAP] absent -> every onStep()/onEvent() call below is a no-op (backward compatible with
  // every pre-existing composition/test that has not wired an ObserverPort yet). When present,
  // onStep(step, detail) fires at each phase boundary this use-case actually crosses, using the
  // SAME step VOCABULARY the legacy runPipeline's own onStep callback emits (src/server/runner.ts's
  // RUN_EVENT_STEPS: "gate" | "classify" | "setup" | "generate" | "validate" | "health" | "execute" |
  // "coverage" | "retry" | "decide" | "done"). Only phases this use-case genuinely executes emit a
  // step — a step the use-case never reaches (e.g. "coverage" on a non-"pass" verdict, or on a
  // non-diff/cross-repo pass — see the guard at the measure phase below) is never fabricated.
  //
  // W4 fix (F1b, audit-verified cutover blocker): onEvent(body) NOW fires LIVE, DURING execute() —
  // test.started/test.passed/test.failed/test.flaky/test.discovered, threaded through
  // ExecutionOpts.onCase/onRunning/onDiscovered at every execute() call site (initial execute AND
  // every FixLoop retry). Previously onEvent was never called anywhere in this use-case (the port
  // existed but nothing reached for it); a caller wanting per-case progress had to reconstruct it
  // POST-HOC from the final RunOutcome.cases array once the whole run had already resolved (the
  // shape src/server/runner.ts's own recordCase() loop still uses on the qa-engine boundary — see
  // that file's own W3 F3/F4 doc). A caller wired to THIS use-case's observer directly now receives
  // both a live per-case stream (via onEvent, as the test actually finishes) and, if it also does
  // its own post-hoc reconstruction from the returned RunQaResult.cases, a SECOND, duplicate set of
  // events — callers combining both must pick one path, not both (this use-case does not de-dupe
  // across that boundary; it is a caller-side composition concern, since the post-hoc path lives
  // outside this port).
  //
  // Honesty note (judgment-day, both judges — this is a DELIBERATE, strictly-additive divergence,
  // not identical rendering): a caller mapping onStep -> RunRecord.step/RunEvents does NOT render
  // byte-identically to the legacy engine. This use-case emits MORE granular steps than legacy's
  // runtime ever did (e.g. a dedicated "health" mid-run pre-flight step legacy never surfaced as
  // its own onStep call), and the FixLoop's retries (below) collapse to exactly ONE "retry"
  // emission per fail-verdict engagement, whereas the legacy runner emits onStep("retry") on EVERY
  // cycle of its own retry loop (src/pipeline.ts:2722, inside `for (let retry = 0; retry < MAX_RETRIES...)`).
  // Both divergences are additive (never fewer/different-meaning steps, only a coarser retry
  // cadence and finer phase granularity) and intentional; matching the legacy's PER-CYCLE retry
  // cadence exactly is a known follow-up, not re-engineered here (FixLoop's own internal cycling
  // stays untouched by this fix).
  observer?: ObserverPort;
  // [SWAP] absent -> the pre-execution grounding gate (Plan 7-R B5) is skipped entirely: the SAME
  // backward-compatible posture as deployGate/setup/observer above. preExecAmbiguityCatches/
  // deterministicSelectorBlocks/catalogGate* all stay the literal 0 they were before this port
  // existed (see gateSignals' own doc), never fabricated. When present, RunQaUseCase invokes it
  // after every spec-producing pass (initial generate, static-fix repair rounds, FixLoop regens) —
  // see PreExecGroundingPort's own header for the full contract.
  preExecGrounding?: PreExecGroundingPort;
  // [SWAP] absent -> the PRE-generate grounding phase (Plan 7-R W4) is skipped entirely: the SAME
  // backward-compatible posture as deployGate/setup/preExecGrounding above. GenerationEnrichment.
  // contextPack/existingSpecFiles and ReviewEnrichment.domSnapshot all stay absent, and generation
  // falls back to its own live-MCP exploration — never fabricated, never blocking. When present,
  // RunQaUseCase invokes it ONCE, after setup and BEFORE the initial generate() call, mirroring
  // legacy's explorer+buildContextPack ordering (src/pipeline.ts:2078-2138) — see
  // PreGenerationGroundingPort's own header for the full contract, including its fail-open posture.
  preGenerationGrounding?: PreGenerationGroundingPort;
  // [SWAP] absent -> ReviewEnrichment.domSnapshot stays absent every review round; the reviewer
  // defers on unverifiable UI facts (today's behavior, unchanged) — never fabricated, never
  // blocking. When present, invoked at the review call site, memoized per round the SAME way
  // legacy's reviewGenerated() memoizes by the sorted spec-name set — see ReviewDomGroundingPort's
  // own header for the full contract, including its fail-open posture.
  reviewDomGrounding?: ReviewDomGroundingPort;
  // [SWAP] absent -> baseEnrichment.staticSignal is never assembled; the field stays entirely
  // absent from every generate() call, byte-identical to today (the SAME backward-compatible
  // posture setup/preGenerationGrounding/reviewDomGrounding already established). CodeGraph Phase 4
  // (design §5.3/§5.4, ADR-2, ADR-7): when present, invoked ONCE per run, before the first
  // generate() call, with the run's REAL BlastRadius (built from classificationIntent.changedFiles
  // — CRITICAL-1; outside diff mode classificationIntent is undefined, so the BlastRadius is empty
  // and the port's own contract short-circuits to ""). Best-effort: a throw is caught and logged,
  // degrading to no staticSignal — never aborts the run (mirrors preGenerationGrounding's own
  // fail-open posture immediately above).
  structuralSignal?: StructuralSignalPort;
  // [SWAP] absent -> RunQaUseCase never assembles serviceLinks/contractDrift; baseEnrichment carries
  // no such fields, byte-identical to today (SAME backward-compatible posture structuralSignal/
  // setup/grounding already established). Stitcher→Generation seam (design §3.5): when present,
  // invoked ONCE per run before the first generate() call. UNLIKE structuralSignal, this is NOT
  // gated on diff mode / classificationIntent (ADR-7) — service links are app-static per SHA
  // (boundary profiles + service list + primary mirror are all fixed for the run before generation
  // begins), so this collaborator runs for EVERY generation mode (diff/complete/exhaustive/manual).
  // Best-effort: a throw is caught and logged, degrading to no serviceLinks/contractDrift — never
  // aborts the run (mirrors structuralSignal's own fail-open posture immediately above).
  serviceLinks?: ServiceLinksPort;
  // [SWAP] absent -> RunQaUseCase never invokes crossRepoImpact; baseEnrichment carries no such
  // field, byte-identical to today (SAME backward-compatible posture serviceLinks/structuralSignal
  // already established). Slice C (structural-signals-expansion, design §3.8): when present,
  // invoked AT MOST once per run — gated on input.triggerRepo being set AND at least one
  // resolvedServiceLinks entry targeting it (the cheap pre-filter, belt-and-braces with the port's
  // OWN identical guard). Same-repo runs (no triggerRepo) NEVER invoke this collaborator at all.
  // Best-effort: a throw is caught and logged, degrading to no crossRepoImpact — never aborts the
  // run (mirrors serviceLinks'/structuralSignal's own fail-open posture).
  crossRepoImpact?: CrossRepoImpactPort;
  // [SWAP] absent -> reflect is skipped entirely at both fold sites; learning.fold() is UNAFFECTED
  // (dormant, pre-cutover-equivalent — the SAME backward-compatible posture crossRepoImpact/
  // serviceLinks/structuralSignal already establish). reflector-rewire design (ADR-1): when present,
  // invoked AFTER learning.fold() at each fold site, gated STRICTER than the fold gate itself —
  // shouldDistillLearning(...) AND verdict !== "flaky" AND errorClass not in {E-INFRA, E-FLAKY} (see
  // this use-case's own toReflectionInput/reflect call sites for the exact gate). Fault-isolated by
  // the adapter (crash/timeout/malformed JSON never propagate here) — this use-case awaits reflect()
  // with no extra try/catch of its own, trusting the adapter's own documented fault-isolation
  // contract (ReflectorPortAdapter's header).
  reflector?: ReflectorPort;
  config?: Partial<RunQaConfig>;
}

export interface RunQaInput {
  app: string;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
  // Cross-repo deploy-event semantics (dual-judge finding, closes the gap the FIX D comment at the
  // FixLoop wiring below used to flag as "RunQaInput has no such field"): mirrors RunInput.triggerRepo
  // (../ports/index.ts) and legacy's triggerService (src/pipeline.ts). Set -> the measure phase must
  // starve ObjectiveSignalPort.measure()'s diff arg so change-coverage degrades to "unknown" (browser
  // coverage cannot map a service repo's changed lines) — the keystone invariant "unknown" NEVER
  // blocks, unchanged. Absent -> ordinary monorepo run, unaffected.
  triggerRepo?: string;
  // Audit CRITICAL (task #33): mirrors legacy's RunOptions.previousNamespace (src/types.ts) — the
  // interrupted PRIOR run's namespace, computed by the caller (src/server/runner.ts's
  // enqueueTrackedRun) ONLY when that prior run's own status was "running"/"enqueued" or its
  // verdict was "infra-error" (see CleanupPort's own header, ports/index.ts, for the full
  // contract). Absent -> the cleanup phase never fires this run, matching legacy's own
  // `opts.previousNamespace &&` guard exactly.
  previousNamespace?: string;
}

export interface RunQaResult {
  decision: RunDecision;
  // Determinism fix (the millisecond gate-flake): the EXACT RunOutcome this run persisted via
  // RunHistoryPort.save(), attached so RewrittenOrchestratorAdapter returns the SAME object instead
  // of re-deriving one with a SECOND `new Date()` (returned-vs-persisted `at` diverged at
  // millisecond boundaries). Absent when nothing was persisted (infra-error/aborted entry-gate
  // terminals, context-mode skipPersist) — the adapter then falls back to its own derivation.
  outcome?: RunOutcome;
  // FIX 1 (judgment-day D.7): errorClass (E-STATIC/E-EXEC-FAIL/E-FLAKY/E-INFRA/E-COVERAGE-GAP/
  // E-VALUE-SURVIVED — the re-ported labeler taxonomy, domain/helpers/error-class.ts), valueScore
  // (FIX 3, the mutation-testing oracle) and reviewerApproved (FIX 1) are surfaced HERE (not just
  // inside the private toRunOutcome() persisted shape) so RewrittenOrchestratorAdapter's toOutcome()
  // — which has NO read-back path on RunHistoryPort — can mirror the SAME fields the use-case
  // already persisted, rather than re-hardcoding them to null a second time at the adapter boundary.
  errorClass: string | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerApproved?: boolean;
    retries: number;
    preExecAmbiguityCatches: number;
    deterministicSelectorBlocks: number;
    // Plan 7-R B5.2/B5.3: Pillar-2 catalog-gate honest-coverage telemetry (mirrors RunOutcome.
    // gateSignals' own catalogGate* fields, @kernel/run-outcome.ts). Always a number (never
    // undefined) once the pre-exec grounding gate is wired, same "0 not undefined" contract as
    // preExecAmbiguityCatches/deterministicSelectorBlocks above.
    catalogGateInWindow: number;
    catalogGateAdvisory: number;
    catalogGateFailClosed: number;
  };
  cases: QaCase[];
  // W3 F3 (HIGH, audit-verified cutover blocker): the execution logs ExecutionPort.execute()
  // already returned (`run.logs`) — mirrors cases' own "surfaced here so toOutcome() can forward
  // it" reasoning. Optional: absent on every early exit that never reached execute() (skip/invalid/
  // pre-execute infra-error), matching cases' own []-vs-absent distinction at those same call sites.
  // NOT a full log-streaming port (CLAUDE.md scope note, see kernel RunOutcome.logs's own doc) —
  // this is the one-shot post-execution string ExecutionPort already produces, nothing more.
  logs?: string;
  // W3 F2 (mirrors errorClass/valueScore/reviewerApproved's own doc above): the retrieved rule IDS
  // (WS1.1 fix — was trigger text, a silent no-op bug; see this file's own retrieve() call-site
  // doc), surfaced HERE so RewrittenOrchestratorAdapter's toOutcome() can mirror the SAME value
  // toRunOutcome() persisted (mainline exit only — see toRunOutcome's own rulesRetrieved doc; every
  // other exit's persisted outcome is [], matching legacy's persistOutcome asymmetry exactly).
  rulesRetrieved: string[];
  // Diagnostic note. Two distinct sources, never both at once (mutually exclusive terminal shapes):
  //  1. An infra-error/invalid-shaped terminal (CLAUDE.md "surface integration errors loudly — never
  //     swallow errors into an empty result"): the InfraError/thrown-error message that caused the
  //     terminal exit, so a run that dead-ends here is diagnosable from the run record alone instead
  //     of requiring live-container instrumentation.
  //  2. FIX F1: the mainline path's PublicationPort.publish() outcome string (e.g. "pr: <url>",
  //     "issue: <url>", "quarantine: ...", "shadow: ...", "noop: ...") whenever publish() was
  //     actually called (decision.sideEffect !== "none") — so a caller can see what the publish
  //     phase did without a RunHistoryPort read-back path.
  // Optional — absent on every terminal that neither threads a diagnostic nor calls publish(); never
  // fabricated.
  note?: string;
}

const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: 2,
  isCode: false,
  // FIX B: "signal" matches src/qa/change-coverage.ts's DEFAULT_COVERAGE_POLICY.mode default — the
  // keystone measures + records but never blocks until an app is deliberately raised to "enforce".
  coveragePolicyMode: "signal",
};

export class RunQaUseCase {
  constructor(private readonly deps: RunQaUseCaseDeps) {}

  async run(input: RunQaInput, signal?: AbortSignal): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };

    // Plan 7.1 (engram #913): an already-aborted signal short-circuits BEFORE the entry gate —
    // the queue cancelled this run before it ever started; there is nothing to gate/prepare/etc.
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // Phase: gate (DeployGatePort). Absent -> always serving (static sites / code target [SWAP]).
    this.deps.observer?.onStep("gate");
    if (this.deps.deployGate) {
      const gateResult = await this.deps.deployGate.waitUntilServing(input.sha);
      if (!isOk(gateResult)) {
        // CLAUDE.md invariant: thread the deploy-gate's own InfraError message (e.g. "DEV did not
        // serve sha ... within ...ms") as the diagnostic note — the raw gateResult.error is already
        // descriptive (deploy-gate-port.adapter.ts), previously dropped entirely here.
        return this.infraErrorResult(gateResult.error.message);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // Phase: prepare (WorkspacePort).
    const workspace = await this.deps.workspace.prepare(input.sha);

    // Phase: classify (ChangeAnalysisPort). Only "diff" mode runs classifyCommit (CLAUDE.md "Run
    // modes") — the others always generate.
    //
    // FIX E (judgment-day): classify-skip is a BARE return in the legacy (src/pipeline.ts:1263-1267)
    // — no persistOutcome call at all (save NO, fold NO). This is DISTINCT from the agent-no-op skip
    // below (save YES, fold NO) even though both currently return the SAME "skipped" verdict — the
    // two sources must diverge on persistence, matching each legacy site exactly.
    //
    // "Dynamic diff" fix (engram #936): classify() (diff mode only) now also returns the commit diff
    // it already fetched internally. Hoisted to `classificationDiff` (undefined outside diff mode,
    // which never classifies) so every GenerationPort.generate() call below — the initial call, the
    // static-fix repair loop, and the FixLoop's own regenerate() — threads the SAME real per-run diff
    // instead of relying on the adapter's static composition-time fallback. This is the ONLY new
    // behavior this fix introduces; classifyCommit's own action/reason table is untouched.
    //
    // W2 fix (F5): classify() also now surfaces the CommitIntent it already derived internally
    // (classifyCommit()'s own CommitClassification extends CommitIntent) — hoisted alongside
    // classificationDiff for the SAME reason: every generate()/review() call below threads the SAME
    // real per-run intent, matching the legacy's baseGenInput({ intent, ... }) (src/pipeline.ts:1678)
    // and the reviewer's own objective derivation (src/pipeline.ts:1682).
    let classificationDiff: string | undefined;
    let classificationIntent: CommitIntent | undefined;
    if (input.mode === "diff") {
      this.deps.observer?.onStep("classify");
      const classification = await this.deps.changeAnalysis.classify(input.sha);
      classificationDiff = classification.diff;
      classificationIntent = classification.intent;
      if (classification.action === "skip") {
        return this.skippedResult();
      }
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    const generating = true; // this composition always attempts generation (diff-mode skip already handled above)

    // Phase: setup (SetupPort) — CLAUDE.md run-flow step 3: bootstraps the config/e2e seed into
    // e2e/ (first time) + npm ci (e2e target), or installs the repo's own deps (code target), so the
    // generator has fixtures/dependencies to build on. Runs strictly AFTER classify resolves to
    // generate/regression (a classify-skip already returned above — setup never runs for a skip) and
    // BEFORE generate() (src/pipeline.ts:1294-1306's own ordering: "Set up the project so the agent
    // has what it needs to build on"). [SWAP] absent SetupPort -> the phase is a no-op (backward
    // compatible with a composition that has not wired one yet). A throw here mirrors the legacy's
    // own contract EXACTLY: src/qa/setup.ts's setupE2eProject/setupCodeProject throw on a failed
    // install/timeout/abort, and the legacy pipeline surfaces that as infra-error, NEVER a code
    // verdict — never persisted (matches infraErrorResult()'s own no-persist convention for every
    // other entry-gate-shaped failure).
    if (this.deps.setup) {
      this.deps.observer?.onStep("setup");
      try {
        await this.deps.setup.setup(workspace.specDir, signal);
      } catch (err) {
        // CLAUDE.md invariant: never swallow an integration error into an empty result — this WAS a
        // bare catch (verdict + nothing else, undiagnosable without live-container instrumentation).
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[qa] setup phase failed:", err);
        return this.infraErrorResult(`setup failed: ${msg}`);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // Phase: cleanup (CleanupPort) — audit CRITICAL (task #33), mirrors legacy's src/pipeline.ts's
    // step "4a" EXACTLY: orphan test-data cleanup for a PREVIOUS run that was interrupted (crash,
    // SIGKILL, docker restart) or ended infra-error, so its leftover DEV data does not accumulate
    // across runs. Runs strictly AFTER setup (legacy's setup — step 4 — is awaited via
    // `Promise.all([gatePromise, setupPromise])` BEFORE step 4a ever executes, src/pipeline.ts:1301-
    // 1306) and BEFORE generation. e2e-only (isCode has no web test data to clean) — mirrors
    // legacy's `!isCode` conjunct (pipeline.ts:1453); the baseUrl conjunct
    // (`app.dev?.baseUrl`) is the ADAPTER's own concern (the SAME "adapter resolves its own
    // static per-run context" precedent ExecutionPortAdapter/SetupPortAdapter already establish —
    // this use-case has no baseUrl of its own anywhere else in its body either). Requires
    // input.previousNamespace (see RunQaInput's own doc — absent means the prior run finished
    // cleanly, nothing to sweep). [SWAP] absent CleanupPort -> the phase is a no-op (backward
    // compatible with every composition that has not wired one yet — the SAME posture setup/
    // preExecGrounding/preGenerationGrounding already established).
    //
    // Best-effort by design (mirrors legacy's own posture EXACTLY — see CleanupPort's own header,
    // ports/index.ts, for the two-layer non-throwing contract this call site still wraps in a THIRD
    // safety net): a cleanup failure of ANY kind is logged as a non-blocking warning and MUST NEVER
    // alter this run's verdict, block generation, or propagate.
    if (this.deps.cleanup && input.previousNamespace && !cfg.isCode) {
      this.deps.observer?.onStep("setup", "orphan-data cleanup (prior interrupted run)");
      try {
        await this.deps.cleanup.cleanup(workspace.specDir, {
          namespace: input.previousNamespace,
          signal,
        });
      } catch (err) {
        console.error(`[qa] cleanup warning (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // W2 fix (F5): the base enrichment every generate()/review() call below shares — the run's sha
    // plus the classification-sourced intent (absent when non-diff mode never classified). sha is
    // ALWAYS present (manifest-enrichment fix: GenerateTestsUseCase stamps every manifest entry's
    // changeRef.sha from OpencodeRunInput.sha, which the adapter reads off enrichment.sha — without
    // it every entry's changeRef would carry an empty sha and fail the manifest schema). Each call
    // site spreads its OWN additional fields (fixCases/reviewCorrections/etc.) on top of this base,
    // mirroring the legacy's baseGenInput({ intent, ...extra }) pattern (src/pipeline.ts:1666-1712).
    // W3 F2 (CRITICAL cutover blocker): retrieve cross-run learning rules BEFORE the first generate()
    // call, mirroring legacy's own ordering (src/pipeline.ts:2019-2042 retrieves before `allPromptSections`
    // is built and threaded into baseGenInput). LearningPort.retrieve() is OFF-PATH by the port's own
    // contract (learning-port.adapter.ts's fold() doc: "a failure is logged and swallowed"); retrieve()
    // itself has no such guard documented on the port, but retrieval failing must not abort generation
    // either (retrieval is an enrichment, not a requirement) — bestEffort-shaped inline try/catch, never
    // propagated. `retrievedRules` (the full structured RetrievedRule[] — trigger/action/errorClass/
    // status/confidence) feeds the PROMPT enrichment (below, baseEnrichment/baseReviewEnrichment's
    // `learnedRules`) — the generator/reviewer render `trigger`/`action` as text, never `id`.
    //
    // WS1.1 (full-flow remediation, most critical finding — FIX, was a silent no-op): `retrievedRuleIds`
    // (derived below) feeds the persisted RunOutcome.rulesRetrieved (toRunOutcome) with the rules'
    // real IDS, not trigger text. Before this fix, this derivation mapped `r.trigger` — the comment
    // here used to claim that mirrored "legacy's retrievedRuleIds dual-use", which was
    // self-contradictory: legacy's own retrievedRuleIds (src/pipeline.ts:2038) was populated from
    // rule IDS, never trigger text. Persisting trigger text broke the consumer's BY-ID fold silently
    // end-to-end: src/server/rewritten-engine-factory.ts's recordOutcome iterates rulesRetrieved
    // calling recordRuleOutcome(id, ...) / looking up `byId.get(id)`, and src/server/history.ts's
    // `SELECT * FROM learning_rules WHERE id = ?` never matched a row — so outcome_count stayed
    // frozen at 0 forever, and the governance fold (promotion/demotion) never engaged. Now that
    // RetrievedRule carries a real `id` (learning-port.adapter.ts's retrieve()), this derivation maps
    // `r.id` — the SAME ids the adapter already threads into incrementUsage() one call earlier.
    let retrievedRules: RetrievedRule[] = [];
    try {
      retrievedRules = await this.deps.learning.retrieve(input.sha);
    } catch (err) {
      console.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", err);
    }
    const retrievedRuleIds = retrievedRules.map((r) => r.id);

    // Phase: pre-generation grounding (Plan 7-R W4, audit CRITICAL). [SWAP] absent
    // PreGenerationGroundingPort -> the phase is a no-op: contextPack/existingSpecFiles stay
    // undefined, generation degrades to its own live-MCP exploration (today's behavior, unchanged).
    // Mirrors legacy's ordering EXACTLY: runs AFTER setup, BEFORE the first generate() call
    // (src/pipeline.ts:2078-2164) — ONCE per run; its output is reused unchanged across every
    // regeneration (the pack is first-write ground truth, never rebuilt on a regen pass).
    //
    // Fail-open by design (mirrors legacy's own posture — see PreGenerationGroundingPort's own
    // header): a real adapter never throws here, but this call is wrapped anyway as a defensive
    // backstop mirroring every other best-effort phase in this use-case (learning.retrieve above,
    // context-pack build in legacy) — a misbehaving adapter must never abort the run over grounding.
    let groundingContextPack: string | undefined;
    let groundingExistingSpecFiles: string[] | undefined;
    if (this.deps.preGenerationGrounding) {
      this.deps.observer?.onStep("generate", "pre-generation grounding");
      try {
        const grounding = await this.deps.preGenerationGrounding.ground(workspace.specDir, signal);
        groundingContextPack = grounding.contextPack;
        groundingExistingSpecFiles = grounding.existingSpecFiles;
      } catch (err) {
        // FIX 1 (judgment-day W4 abort-plumbing): an abort DURING grounding must take the ABORT
        // route, never the degraded-ungrounded-continue route below.
        if (signal?.aborted) return this.abortedResult();
        console.error("[qa] WARNING: pre-generation grounding failed (non-fatal, generation continues ungrounded):", err);
      }
    }
    // FIX 1 (judgment-day W4 abort-plumbing): the adapter's own contract never throws on abort
    // (it resolves a possibly-partial GroundingResult instead — see the port adapter's own docs),
    // so this is the check that actually catches an abort observed during ground() and routes it
    // to the ABORT path instead of silently continuing into baseEnrichment/generate() below.
    if (signal?.aborted) return this.abortedResult();

    // CodeGraph Phase 4 (design §5.4, ADR-7 — CRITICAL-1): the REAL non-empty BlastRadius, built
    // from classificationIntent.changedFiles (the diff-mode classify() call above ALREADY derived
    // this — the SAME source the "dynamic diff"/W2-F5 intent threading above uses). Outside diff
    // mode classificationIntent stays undefined -> an empty BlastRadius -> the structuralSignal
    // port's own contract short-circuits to "" (matches every other mode's absent-section
    // behavior).
    //
    // WS2.3 (full-flow remediation, code-mode restoration): this SAME BlastRadius is now ALSO
    // threaded into both objectiveSignal.measure() calls below (mainline measurement + the
    // enforce-mode coverage-regen re-measure) — previously each passed its own
    // `BlastRadius.of(input.sha, [])` empty-literal placeholder, so StrykerMutationOracleAdapter's
    // `br.changedFiles` forward into selectMutateTargets never scoped the mutation run to the
    // diff on the code target (unscoped: slower, and a diluted valueScore feeding WS1.4's
    // promotion gate). e2e's fault-injection oracle ignores `br` entirely, so reusing this one
    // BlastRadius for both consumers is strictly narrowing for code and a no-op for e2e — no
    // second, independently-computed BlastRadius needed.
    const runBlastRadius = BlastRadius.of(input.sha, classificationIntent?.changedFiles ?? []);
    // Best-effort by design (mirrors preGenerationGrounding's own fail-open posture immediately
    // above): a throw from the port is caught and logged, degrading to "" (no staticSignal) —
    // this seam is advisory-only and must never abort a run.
    let blastRadiusSignal = "";
    if (this.deps.structuralSignal) {
      try {
        blastRadiusSignal = await this.deps.structuralSignal.render(workspace.specDir, runBlastRadius);
      } catch (err) {
        console.error("[qa] WARNING: structural blast-radius signal failed (non-fatal, generation continues without it):", err);
      }
    }

    // Stitcher→Generation seam (design §3.5, ADR-7): UNLIKE blastRadiusSignal above, this block is
    // NOT gated on diff mode / classificationIntent — service links are app-static per SHA (the
    // boundary profiles, service list, and primary mirror are all fixed for the run before
    // generation begins), so invoke for EVERY generation mode. Best-effort by design (mirrors
    // structuralSignal's own fail-open posture immediately above): a throw from the port is caught
    // and logged, degrading to {links:[],drift:[]} — this seam is advisory-only and must never abort
    // a run.
    let resolvedServiceLinks: readonly ServiceLink[] = [];
    let resolvedContractDrift: readonly ContractDrift[] = [];
    if (this.deps.serviceLinks) {
      try {
        const r = await this.deps.serviceLinks.resolve();
        resolvedServiceLinks = r.links;
        resolvedContractDrift = r.drift;
      } catch (err) {
        console.error("[qa] WARNING: service-links resolution failed (non-fatal, generation continues without it):", err);
      }
    }

    // Slice C (structural-signals-expansion, design §3.8): the advisory cross-repo impact
    // composition — fires ONLY on cross-repo runs. The cheap pre-filter (`.some(...)` below) is a
    // PERFORMANCE addition on top of the port's OWN identical guard (design C.4 step 0):
    // input.triggerRepo presence already means "cross-repo" (runner.ts validates it), so this skips
    // even the await hop for the common no-match case rather than paying it to discover "no match"
    // inside the port. Best-effort: a throw is caught and logged, never aborts the run.
    let crossRepoImpact: CrossRepoImpact | null = null;
    if (
      this.deps.crossRepoImpact &&
      input.triggerRepo &&
      resolvedServiceLinks.length &&
      resolvedServiceLinks.some((l) => l.to.repo === input.triggerRepo)
    ) {
      try {
        crossRepoImpact = await this.deps.crossRepoImpact.resolve(input.triggerRepo, input.sha.toString(), resolvedServiceLinks);
      } catch (err) {
        console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", err);
      }
    }

    // W5 fix (seam-parity FIXME): thread runId into both enrichment bases — the SAME "dynamic"
    // per-run precedent sha/intent above already establish. RunQaInput.runId (this use-case's own
    // input) is available on every run, so it is unconditional (matching sha's own unconditional
    // spread), not gated behind a presence check the way classificationIntent/retrievedRules are.
    const baseEnrichment = {
      sha: input.sha.toString(),
      runId: input.runId,
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
      ...(groundingContextPack ? { contextPack: groundingContextPack } : {}),
      ...(groundingExistingSpecFiles?.length ? { existingSpecFiles: groundingExistingSpecFiles } : {}),
      ...(blastRadiusSignal ? { staticSignal: blastRadiusSignal } : {}),
      ...(resolvedServiceLinks.length ? { serviceLinks: resolvedServiceLinks } : {}),
      ...(resolvedContractDrift.length ? { contractDrift: resolvedContractDrift } : {}),
      // Slice C (structural-signals-expansion, design §3.8): mirrors serviceLinks' own conditional-
      // spread precedent — absent/empty crossRepoImpact never adds the key at all.
      ...(crossRepoImpact?.impactedLinks.length ? { crossRepoImpact: { impactedLinks: crossRepoImpact.impactedLinks } } : {}),
    };
    // The reviewer's own enrichment base — SEPARATE from baseEnrichment (generation-shaped) because
    // ReviewEnrichment carries domSnapshot, not contextPack/existingSpecFiles (generation-only
    // fields; ReviewPort has no slot for either). domSnapshot is threaded per-round at the review
    // call site (below), keyed on the CURRENT specs — mirrors legacy's reviewGenerated() memoized
    // capture exactly (ReviewDomGroundingPort's own header).
    // FIX 2 (judgment-day, judge A finding #4): no `sha` field here — ReviewEnrichment does NOT
    // declare one (unlike GenerationEnrichment, which needs sha for manifest changeRef stamping)
    // and review-port.adapter.ts never reads it. runId IS the legitimate per-run identifier
    // ReviewEnrichment declares (W5 fix) — carrying sha alongside it would be dead weight.
    const baseReviewEnrichment = {
      runId: input.runId,
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
    };

    // Phase: generate (GenerationPort).
    this.deps.observer?.onStep("generate");
    let generated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, baseEnrichment);

    // Diagnosability fix (live-run root cause): when generation comes back with ZERO specs AND
    // approved===false, the agent almost always left an explanatory note (e.g. "no LIVE DEV URL
    // was provided — Playwright DOM grounding is mandatory before writing selectors, so this run
    // aborted"). This is NOT the agent-no-op skip below (that branch requires approved===true) — an
    // empty, unapproved suite falls through to validate()/health with nothing to show for it, and
    // previously the agent's own note was silently dropped, undiagnosable without digging the raw
    // agent-session transcript. Stashed here and threaded into whichever terminal this run actually
    // reaches (the static-gate "invalid" or the health-preflight "infra-error" below) so the note
    // survives to the persisted RunOutcome. Never invents new verdict semantics — only carries an
    // already-produced diagnostic forward.
    const generationNote = !generated.approved && generated.specs.length === 0 && generated.note ? generated.note : undefined;

    // Agent no-op: approved + zero specs -> skipped (CLAUDE.md invariant: a VALID skipped, never invalid).
    //
    // FIX E (judgment-day): the legacy calls persistOutcome(skipped) here (src/pipeline.ts:2226-2234)
    // — save YES, fold NO (foldRunLearning is never called for this source). This use-case's own
    // skippedResult() previously never persisted at all — that ONLY matched the classify-skip
    // source above (a bare return), silently dropping the agent-no-op skip's own save call.
    if (generated.approved && generated.specs.length === 0) {
      // FIX 1 (judgment-day D.7 batch 2): persistOutcome (src/pipeline.ts:2233) is the SAME closure
      // at EVERY call site — `app.qa.needsReview && result ? result.approved : null` reads
      // `result.approved` here too (the agent-no-op case is `result.approved===true` by definition
      // of this very branch's own guard). Thread the SAME generation-sourced value the terminal
      // exits below use, not a silently-dropped undefined.
      const skipped = this.skippedResult(cfg.needsReview ? generated.approved : undefined);
      const skippedOutcome = this.toRunOutcome(input, skipped.decision, [], 0, null, skipped.errorClass, {
        reviewerApproved: skipped.gateSignals.reviewerApproved,
      });
      await this.deps.runHistory.save(skippedOutcome);
      return { ...skipped, outcome: skippedOutcome };
    }

    // FIX 3 (judgment-day D.7 batch 2): retries is hoisted ABOVE the validate phase (the legacy's
    // own module-scope `retries` variable is incremented by BOTH the static-fix loop below AND the
    // FixLoop further down, accumulating into ONE shared counter across both loops — src/
    // pipeline.ts:2265's `retries++` in the static-fix loop, and the FixLoop's own retries++ per
    // verdictual round). Declared here (not reassigned to a fresh 0 at the FixLoop section below).
    let retries = 0;
    // post-cutover-remediation P3 (unit 4): the FixLoop's own adjudicator verdict class
    // (FixLoopResult.lastAdjudicatorVerdict), hoisted to the SAME method-level scope as `retries`
    // above — captured inside the FixLoop branch below, read at the mainline toRunOutcome call much
    // further down. Stays undefined for every run whose FixLoop never engaged (context mode's
    // synthetic pass, or a first-try pass) — never fabricated.
    let lastAdjudicatorVerdictClass: string | undefined;
    // WS3.1 (adjudication -> Issue body): the FixLoop's own FULL last adjudicator verdict (class +
    // confidence + reason), hoisted alongside lastAdjudicatorVerdictClass above and captured at the
    // SAME site — read at the publish() call site below so the human reading the GitHub Issue sees
    // the engine's own diagnosis, not just a bare class string. Same "never fabricated" contract:
    // stays undefined for every run whose FixLoop never engaged.
    let lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;

    // Phase: pre-exec grounding gate (Plan 7-R B5). [SWAP] absent PreExecGroundingPort -> the whole
    // phase (W1 below + the W2 re-check further down) is a no-op; the counters stay the literal 0
    // they were before this port existed (RunQaUseCaseDeps.preExecGrounding's own doc). Accumulated
    // here so they survive into the final gateSignals regardless of which terminal this run reaches
    // (mirrors legacy's module-scope accumulators, src/pipeline.ts:1928-1930/1975).
    let preExecAmbiguityCatches = 0;
    let deterministicSelectorBlocks = 0;
    let catalogGateInWindow = 0;
    let catalogGateAdvisory = 0;
    let catalogGateFailClosed = 0;
    // Re-runs the gate against the CURRENT on-disk specs (re-reads on every call, per
    // PreExecGroundingPort's own doc — required so a re-check after a corrective regen sees the
    // REWRITTEN specs, never a stale capture) and accumulates telemetry. Returns the corrections for
    // the caller to thread into the NEXT spec-producing regen's selectorContradictions channel.
    const runPreExecGrounding = async (): Promise<string[]> => {
      if (!this.deps.preExecGrounding) return [];
      const { specSources, routes } = await this.deps.preExecGrounding.capture(workspace.specDir, signal);
      const result = checkPreExecGrounding({ specSources, routes });
      preExecAmbiguityCatches += result.preExecAmbiguityCatches;
      catalogGateInWindow += result.catalogGateInWindow;
      catalogGateAdvisory += result.catalogGateAdvisory;
      catalogGateFailClosed += result.catalogGateFailClosed;
      return result.corrections;
    };
    // W1 — pre-execution corrective pass (Plan 7-R B5, mirrors src/pipeline.ts:2166-2188 exactly):
    // detect ambiguity/fabricated-selector corrections against the INITIAL `generated` specs and, if
    // any, feed them through ONE corrective regen via the SAME selectorContradictions channel FixLoop
    // uses below, BEFORE the static gate ever runs — so the agent scopes/corrects before the first
    // execution. ONLY adopt the corrective regen if it produced specs (mirrors legacy's own guard,
    // src/pipeline.ts:2183-2187): an EMPTY result (cycle-ceiling hit, or an agent no-op) must NOT
    // discard the original specs — they remain on disk and are what the static gate + W2 re-check
    // below must reason about.
    const w1Corrections = await runPreExecGrounding();
    if (w1Corrections.length > 0) {
      this.deps.observer?.onStep("retry", "pre-exec grounding: corrective regen (W1)");
      const corrected = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        selectorContradictions: w1Corrections,
      });
      if (corrected.specs.length > 0) {
        generated = corrected;
      }
    }
    // Any FixLoop regen further down still needs to see W1's own corrections (a persisting ambiguity
    // the corrective regen above didn't resolve is exactly what the FixLoop's post-execution-failure
    // regen should also be told about) — threaded via pendingSelectorContradictions, refreshed by the
    // W2 re-check below once the static gate settles.
    let pendingSelectorContradictions: string[] = w1Corrections;

    // Phase: validate (ValidationPort) — with the static-fix loop (Task D.5's own explicit scope:
    // "validate (ValidationPort, static-fix loop)"), ported VERBATIM from the legacy
    // (src/pipeline.ts:2258-2278). A single trivial static-gate error (an unused var, a stray
    // import) used to fail the WHOLE run invalid with no second chance while execution failures
    // already got a fix-loop — this loop closes that asymmetry: feed the validation errors back via
    // a fresh GenerationPort.generate() call and re-validate, bounded by MAX_STATIC_FIX_ROUNDS (=2,
    // src/pipeline.ts:804, verbatim). Skipped entirely when nothing was generated to repair (mirrors
    // the legacy's own `(result?.specs.length ?? 0) > 0` conjunct at src/pipeline.ts:2261).
    //
    // WS4 (full-flow remediation, 4.3): the repair regen call threads the validation errors into
    // GenerationEnrichment.fixCases — a synthetic single QaCase named "static-gate" carrying the
    // (bounded) error text, so the repair prompt actually shows WHAT tsc/eslint reported, instead of
    // the bare `baseEnrichment` this use-case previously spread with no feedback channel at all.
    // ONLY the repair rounds below get this enrichment — the INITIAL generate() call (above this
    // loop) never carries it, matching the loop's own "nothing to repair yet" scope.
    //
    // `lastGenerated` mirrors the legacy's own `result` reassignment across the loop (src/
    // pipeline.ts:2269's `result = await generateOnce(...)`) — the LATEST generation attempt's own
    // `approved` flag is what FIX 1's reviewerApprovedFromGeneration (below) must read, not the
    // stale pre-repair `generated` value.
    // WS2.2 (full-flow remediation, code-mode restoration): changedFiles threads the SAME
    // classificationIntent-derived scoping runBlastRadius uses (below, structuralSignal/measure) into
    // the code-target compile gate (CodeValidationStrategy -> validateCodeProject) for diff-scoped
    // compilation on monorepos (legacy parity: src/pipeline.ts's `intent?.changedFiles ?? []` at
    // every deps.validateCode call site). Ignored by the e2e static gate. Empty outside diff mode
    // (classificationIntent stays undefined) — the code-target strategy's own fallback then probes
    // the working tree directly (validateCodeProject's `effectiveChangedFiles`), never a crash.
    const validateChangedFiles = classificationIntent?.changedFiles ?? [];
    this.deps.observer?.onStep("validate");
    let validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
    let lastGenerated = generated;
    let staticFixRounds = 0;
    while (!validation.ok && !validation.infra && generating && lastGenerated.specs.length > 0 && staticFixRounds < MAX_STATIC_FIX_ROUNDS) {
      // Plan 7.2 (closes the INFO gap in engram #916): a cancel requested mid-repair must stop the
      // loop BEFORE burning another generate()+validate() round-trip — without this check the loop
      // would still consume its full remaining repair budget before the next phase-boundary check
      // (post-validate, below) could ever observe the abort.
      if (signal?.aborted) {
        return this.abortedResult();
      }
      staticFixRounds++;
      retries++;
      // Mirrors the legacy runner's own `retrying: step === "retry"` signal (src/server/
      // runner.ts) — a static-fix repair round IS a retry from the observer's point of view.
      this.deps.observer?.onStep("retry", `static-fix round ${staticFixRounds}/${MAX_STATIC_FIX_ROUNDS}`);
      // "Dynamic diff" fix: the repair regeneration reuses the SAME classificationDiff, not a
      // dropped/empty value — a repair round must see the same real change context the initial
      // generate() call did. W2 fix (F5): same for classificationIntent, via baseEnrichment.
      //
      // WS4 (4.3): bound the error text before threading it — a raw tsc/eslint dump can be
      // arbitrarily long; cap at STATIC_GATE_ERROR_DETAIL_MAX_CHARS so the prompt payload stays sane.
      const staticGateErrorDetail = validation.errors.join("\n\n").slice(0, STATIC_GATE_ERROR_DETAIL_MAX_CHARS);
      lastGenerated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        fixCases: [{ name: "static-gate", status: "fail", detail: staticGateErrorDetail }],
      });
      validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
    }

    // W2 — deterministic block re-check (Plan 7-R B5, mirrors src/pipeline.ts:2282-2299 exactly):
    // re-check the CURRENT (post static-fix) specs against the live DOM, and if a strict-mode
    // ambiguity PERSISTS, fold it into the static gate so the EXISTING "invalid" path holds the run
    // before execution. Re-checking FRESH here (not reusing W1's stale corrections) means a
    // static-fix rewrite cannot leave a stale block AND a no-op corrective regen is still caught (the
    // on-disk specs are authoritative). Guarded by `preExecAmbiguityCatches > 0` (only re-render when
    // W1 found something) and `validation.ok` (a real tsc/eslint failure already routes to invalid
    // first — mirrors legacy exactly). SAFE DIRECTION (load-bearing): checkPersistingAmbiguity is the
    // AMBIGUITY-ONLY half of the gate — catalog corrections NEVER reach this block, only the one-shot
    // repair channel above (W1) and the FixLoop's own regen channel below.
    if (this.deps.preExecGrounding && preExecAmbiguityCatches > 0 && validation.ok) {
      const { specSources, routes } = await this.deps.preExecGrounding.capture(workspace.specDir, signal);
      const persisting = checkPersistingAmbiguity({ specSources, routes });
      deterministicSelectorBlocks = persisting.length;
      if (persisting.length > 0) {
        validation = {
          ok: false,
          infra: false,
          errors: persisting.map((a) => `strict-mode selector ambiguity (deterministic — would fail at runtime; scope to a unique parent): ${a}`),
        };
      }
    }

    // FIX 1 (judgment-day D.7 batch 2): the SAME generation-sourced reviewerApproved default the
    // mainline path computes (see the "Phase: review" comment below for the full root-cause) is
    // needed at these two earlier terminal exits too — both fire strictly after generation
    // (including any static-fix repair rounds above) has already run. Reads `lastGenerated` (the
    // LATEST generation attempt), not the original `generated`, so a repaired spec's own approved
    // flag is what persists — matching the legacy's `result` reassignment across the static-fix loop.
    const reviewerApprovedFromGeneration = cfg.needsReview ? lastGenerated.approved : undefined;

    if (!validation.ok) {
      // FIX 2 (judgment-day D.7 batch 2): a context-mode validate() failure is this composition's
      // closest faithful proxy for the legacy's DISTINCT validateContextFn check over the built
      // context.json (this use-case has no dedicated context-validate port — see the scope note on
      // the context-mode execute-skip branch below) — it must NOT persist, matching
      // buildContextMap's own invalid branch (src/pipeline.ts:1377-1404), which files an Issue but
      // never reaches persistOutcome. Every OTHER mode's static-gate invalid still persists exactly
      // as before.
      //
      // WS2.2 (full-flow remediation, code-mode restoration): the verdict-mapping divergence this
      // comment used to declare as "known, tracked in parity-allowlist.json" is CLOSED — empirically
      // re-verified (judgment-day mandate) that parity-allowlist.json and golden-outcome.test.ts do
      // NOT exist anywhere in the tree (both deleted at the Plan 7.6 cutover along with the rest of
      // the legacy characterization harness), so there was no live allowlist entry left to "break" —
      // the comment had gone stale. `run-decision-parity.test.ts`'s `codemode-infra-toolchain`
      // scenario asserts the DESIRED evidence->decide() mapping in isolation (a hand-fed
      // RunEvidence table exercising ONLY decide(), never this use-case's own validate() branch) —
      // it was aspirational, not a live pin of this code path; before this fix, a real toolchain-
      // missing validate() call landed here and returned "invalid" unconditionally, matching
      // neither legacy's own infra split (src/pipeline.ts:2305) nor that test's intent. Branching on
      // validation.infra restores legacy semantics for BOTH targets uniformly (the field means the
      // same thing regardless of what produced it: the gate itself could not run — a broken/missing
      // toolchain, playwright binary, tsc/mvn/go absent — never a code-quality defect to blame on
      // the agent or the generated tests).
      console.error("[qa] static gate failed:", validation.errors);
      // Diagnosability fix: an empty, unapproved generation (generationNote, above) reaching this
      // static-gate failure means the static-gate errors ALONE would hide WHY nothing was
      // generated in the first place — append the agent's own note so both are visible.
      const staticGateNote = [validation.errors.slice(0, 2).join("\n\n") || undefined, generationNote]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") || undefined;
      return await this.terminalResult(
        validation.infra ? "infra-error" : "invalid",
        cfg,
        input,
        { generating, static: false },
        reviewerApprovedFromGeneration,
        !validation.infra && input.mode === "context",
        // FIX 3 (judgment-day D.7 batch 2): the static-fix loop's own accumulated retries (repair
        // rounds consumed before the static gate finally gave up) — verified empirically against
        // the real legacy runPipeline (retries:2 for an always-failing validate(), matching
        // MAX_STATIC_FIX_ROUNDS's own bound exactly).
        retries,
        staticGateNote,
        // Plan 7-R B5.3 (leak 3 fix): this exit fires strictly after W1 (pre-validate) and, when
        // validation.ok held long enough to reach it, W2 (post-static-fix-loop) — real accumulated
        // values, not the hardcoded 0 this terminal used to carry.
        { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
        // WS1.6 (full-flow remediation): this exit fires strictly after learning.retrieve() (the
        // static gate runs post-generate, retrieval runs pre-generate) — the real retrieved ids, not
        // the terminal helper's own [] default.
        retrievedRuleIds,
      );
    }

    // Phase: health (mid-run DEV pre-flight, distinct from the entry gate). Derived from
    // DeployGatePort — absent (static sites / code target) defaults to always-healthy.
    //
    // CLAUDE.md invariant: devHealthy() is reused verbatim by the FixLoop below (its own
    // boolean-returning contract must not change), so the gate's InfraError message is captured
    // as a side effect into this closure variable rather than widening the return type — the LAST
    // health-check failure's message is what the mid-run terminal below (and any FixLoop-internal
    // health check) can report.
    this.deps.observer?.onStep("health");
    let lastHealthCheckError: string | undefined;
    const devHealthy = async (): Promise<boolean> => {
      if (!this.deps.deployGate) return true;
      const result = await this.deps.deployGate.waitUntilServing(input.sha);
      if (!isOk(result)) {
        lastHealthCheckError = result.error.message;
        return false;
      }
      return true;
    };
    if (!(await devHealthy())) {
      // FIX 1 (judgment-day D.7 batch 2 — newly unmasked by threading reviewerApproved through this
      // exact branch): the static gate already passed (validation.ok) by the time the health
      // pre-flight runs, but the legacy's own persistOutcome call for THIS exact exit (src/
      // pipeline.ts:2334) never passes a `staticOk` override at all — persistOutcome's own default
      // (`overrides?.staticOk ?? false`) is what actually gets persisted, i.e. `false`, despite
      // validation having genuinely passed. This is a real (if arguably quirky) legacy behavior, not
      // a design choice made here — `static: false` mirrors it verbatim rather than the more
      // "logical" `true`, matching the persisted field the legacy ACTUALLY writes for this source.
      //
      // FIX 3 (judgment-day D.7 batch 2): retries (the static-fix loop's own accumulated count,
      // which genuinely CAN be nonzero here — the static gate already passed, possibly after
      // repair rounds, by the time this mid-run health check fires) is threaded through — verified
      // empirically against the real legacy runPipeline (a preceding repair round's retries++
      // survives into this exact persisted exit, since `retries` is one shared accumulator across
      // the whole legacy function body, src/pipeline.ts:1027).
      // CLAUDE.md invariant: thread a diagnostic note so this terminal is no longer silent — the
      // captured gate error message when available, else a generic fallback (the gate can also be
      // absent per its own [SWAP] contract, though that path can never reach `!devHealthy()`).
      // Diagnosability fix: append generationNote (if this run's generation also came back empty
      // and unapproved) so a health-preflight infra-error doesn't bury an earlier agent-reported
      // reason (e.g. missing baseUrl) behind the LATER health-check message alone.
      const healthNote = [lastHealthCheckError ?? "DEV health pre-flight failed before execute", generationNote]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      console.error("[qa] health pre-flight failed before execute:", healthNote);
      return await this.terminalResult(
        "infra-error",
        cfg,
        input,
        { generating, static: false },
        reviewerApprovedFromGeneration,
        false,
        retries,
        healthNote,
        // Plan 7-R B5.3 (leak 3 fix): this exit fires strictly after both W1 and W2 have already run
        // (post static-fix loop, pre-execute) — real accumulated values, not the hardcoded 0 this
        // terminal used to carry.
        { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
        // WS1.6 (full-flow remediation): this exit fires strictly after learning.retrieve() (retrieval
        // runs pre-generate; this health pre-flight runs post-generate/post-static-fix-loop) — the
        // real retrieved ids, not the terminal helper's own [] default. Note: decide()'s own sideEffect
        // for "infra-error" is "none" (no Issue), and the fold/reflect gates above are both hard-gated
        // on `verdict === "invalid"`, so this infra-error call site's ids reach the PERSISTED
        // RunOutcome.rulesRetrieved (diagnosability) but never reach a fold/reflect call — infra-error
        // stays fold-free and reflect-free, unchanged by this fix.
        retrievedRuleIds,
      );
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // Phase: execute (ExecutionPort) — SKIPPED entirely for "context" mode.
    //
    // FIX C (judgment-day): the legacy's context-mode branch (buildContextMap, src/pipeline.ts:1327)
    // diverges BEFORE execution — context.json is not a Playwright spec, so there is nothing to run
    // against DEV, and the deploy gate/versionUrl are also skipped for this mode (:1157,
    // `(isCode || mode === "context") ? undefined : app.dev?.versionUrl`). The legacy validates via
    // validateContextFn and publishes via publishContext, but NEVER calls execute() or the FixLoop.
    //
    // Scope note (explicit, for Task E.0): this composition's ValidationPort/PublicationPort/
    // ObjectiveSignalPort/ReviewPort are the SAME generic ports used for every other mode — the
    // barrel does not (yet) expose context-shaped validate/publish variants. The minimal faithful
    // fix here is "never execute a context build" (this use-case's own scope); the composition root
    // (Task E.0) MUST wire context-appropriate ValidationPort/PublicationPort adapters (or a
    // dedicated context validate/publish port) so a real context run's static gate and publish
    // target context.json rather than e2e specs. Until then, this use-case still calls the SAME
    // ValidationPort.validate(specDir) above (harmless for the stub-shaped 10-scenario parity,
    // which stubs validate() to `ok:true` uniformly) and treats a context build's successful
    // generation as an immediate "pass" with zero cases (nothing was executed, so there is nothing
    // to report per-case) — never fabricating a Playwright run.
    if (input.mode !== "context") {
      this.deps.observer?.onStep("execute");
    }
    // W4 fix (F1b, audit-verified cutover blocker): live per-case/per-test progress, threaded
    // through ExecutionOpts.onCase/onRunning/onDiscovered so ObserverPort.onEvent fires
    // test.started/test.passed/test.failed/test.discovered DURING execution rather than only being
    // reconstructable AFTER the fact from the final case list. Absent observer -> every callback is
    // a no-op (matches every other onStep/onEvent call site in this use-case — [SWAP] backward
    // compatible with a composition that has not wired an ObserverPort).
    const liveExecutionOpts = {
      ...(signal ? { signal } : {}),
      onCase: (c: QaCase) => {
        this.deps.observer?.onEvent(
          c.status === "pass"
            ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
            : c.status === "fail"
              ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
              : { type: "test.flaky", name: c.name, attempts: 2 },
        );
      },
      onRunning: (title: string) => {
        this.deps.observer?.onEvent({ type: "test.started", name: title });
      },
      onDiscovered: (title: string, file?: string) => {
        this.deps.observer?.onEvent({ type: "test.discovered", name: title, ...(file ? { file } : {}) });
      },
    };
    let run = input.mode === "context"
      ? { verdict: "pass" as const, cases: [] as QaCase[], logs: generated.note ?? "" }
      : await this.deps.execution.execute(workspace.specDir, liveExecutionOpts);
    if (signal?.aborted) {
      return this.abortedResult();
    }

    // Phase: FixLoop (Task D.4) — driven only when the initial verdict is "fail". Context mode's
    // synthetic "pass" above never enters this branch, matching the legacy's "never execute" rule.
    // FIX 3 (judgment-day D.7 batch 2): `retries` is hoisted above the validate phase (declared
    // once, at the top of this method) so the static-fix loop's own retries++ accumulates into the
    // SAME shared counter the FixLoop below adds to — matching the legacy's single module-scope
    // `retries` variable, incremented by both loops.
    if (run.verdict === "fail") {
      this.deps.observer?.onStep("retry", "fix-loop engaged after a failing execute()");
      const fixLoopExecution: FixLoopExecutionPort = {
        // W4 fix (F1a, audit-verified cutover blocker): FixLoopExecuteInput.specFiles (the
        // aggregate's OWN filtered-retry decision — fix-loop.aggregate.ts:359-382's canFilter/
        // failedSpecFiles, mirroring legacy's `canFilter ? { specFiles: failedSpecFiles } : {}`,
        // src/pipeline.ts:2833) was previously dropped on the floor here: this closure ignored its
        // own `input` argument and always re-ran the FULL suite. Now threaded through the widened
        // ExecutionPort.execute(specDir, opts) opts bag — a filtered retry genuinely scopes to only
        // the failing spec files, matching the legacy's re-run-time savings on large suites. Live
        // per-case events (F1b) are threaded on every retry too, not just the initial execute.
        //
        // NOT threaded: fixLoopInput.namespace (the aggregate's own per-attempt `retryNs =
        // "${namespace}-r${retry+1}"`, fix-loop.aggregate.ts:357/380) — ExecutionPort.execute's
        // namespace is STATIC, baked into the composition root's ExecutionPortAdapter constructor
        // context (composition-root.ts's `namespace: cfg.branch`), not a per-call parameter this
        // barrel exposes. This is a PRE-EXISTING, separate gap (FixLoopResult.coverageNamespace is
        // not read anywhere in this use-case today either — confirmed unwired before this fix) and
        // out of scope for the execute()-opts widening this fix makes: closing it needs a per-call
        // namespace override added to ExecutionOpts, a distinct follow-up.
        execute: async (fixLoopInput) => {
          const r = await this.deps.execution.execute(workspace.specDir, {
            ...liveExecutionOpts,
            ...(fixLoopInput.specFiles ? { specFiles: fixLoopInput.specFiles } : {}),
          });
          return { verdict: r.verdict, cases: r.cases };
        },
      };
      const fixLoopGeneration: FixLoopGenerationPort = {
        // W2 fix (F2, audit-verified cutover blocker): the FixLoop calls this closure with
        // FixLoopGenerateInput (fixCases, selectorContradictions, domSnapshot, cycleBudget,
        // wallClockBudget) — see fix-loop.aggregate.ts's own regeneration call site (:316-322). This
        // closure previously DISCARDED that entire input, so every fix-loop retry regenerated with
        // the SAME contextless prompt as the very first attempt, never rendering the legacy's "Fix
        // failing tests" section (src/pipeline.ts:912-924's fixCases/reviewCorrections rendering) —
        // the agent had no idea WHAT failed or WHY. Forwarded here through F1's enrichment object,
        // alongside the SAME classificationDiff/classificationIntent every other generate() call
        // site already threads.
        generate: async (fixLoopInput) => {
          // "Dynamic diff" fix: the FixLoop's own regenerate() call also reuses the SAME
          // classificationDiff — every generation attempt across the whole run sees the same real
          // per-run diff, never a stale/empty static fallback.
          //
          // Plan 7-R B5.3: merge the pre-exec grounding gate's own leftover corrections
          // (pendingSelectorContradictions — W1's one-shot repair, refreshed by the W2 re-check
          // above) with the FixLoop's OWN post-execution-failure selector check
          // (fixLoopInput.selectorContradictions, a DIFFERENT mechanism — re-checks against the
          // FAILURE-POINT DOM via fixLoopSelectorCheck below, not the pre-execution DOM). Both are
          // real, independent evidence for the SAME regen call; neither suppresses the other.
          const mergedSelectorContradictions = [
            ...pendingSelectorContradictions,
            ...(fixLoopInput.selectorContradictions ?? []),
          ];
          const r = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
            ...baseEnrichment,
            fixCases: fixLoopInput.fixCases,
            ...(mergedSelectorContradictions.length ? { selectorContradictions: mergedSelectorContradictions } : {}),
            ...(fixLoopInput.domSnapshot ? { domSnapshot: fixLoopInput.domSnapshot } : {}),
          });
          // Pre-exec grounding corrections are a ONE-SHOT repair (mirrors legacy's own W1 posture —
          // never re-threaded into every subsequent FixLoop round once they've been offered once);
          // clear them after this first FixLoop regen so later rounds rely solely on the FixLoop's
          // own fresh post-failure selector check.
          pendingSelectorContradictions = [];
          // WS4 (full-flow remediation, 4.1): forward the JUST-GENERATED spec sources back to the
          // aggregate — fix-loop.aggregate.ts's own run() stores this as `lastRegenResult.specSources`
          // and reads it at the START of the NEXT round's Lever-2 check (FixLoopGenerateResult.
          // specSources' own doc: "every round AFTER round 0 ... uses the CURRENT regen call's OWN
          // FixLoopGenerateResult.specSources, fresh every round"). Previously dropped here, so every
          // round after the first re-armed Lever-2 with an empty array regardless of what the
          // GenerationPort adapter actually produced.
          return { specs: r.specs, approved: r.approved, note: r.note, specSources: r.specSources };
        },
      };
      const fixLoopSelectorCheck: FixLoopSelectorCheckPort = {
        check: (specSources, trees) => checkSpecSelectors(specSources, trees),
      };
      const fixLoop = new FixLoop({
        execution: fixLoopExecution,
        generation: fixLoopGeneration,
        selectorCheck: fixLoopSelectorCheck,
        // WS4 (full-flow remediation, 4.2): reuse the EXISTING ValidationPort — no new port. Mirrors
        // the legacy's own re-validate-before-retry-execute step (fix-loop.aggregate.ts:351-354's
        // `if (this.deps.revalidate) { ... if (!reValidation.ok) break; }`). Before this fix, a
        // regenerated e2e spec with a compile error silently skipped straight to a live DEV
        // execution to discover what tsc/eslint already knew — this closes that gap by giving the
        // aggregate's own [SWAP] contract a real collaborator instead of the graceful no-op default.
        revalidate: (specDir) => this.deps.validation.validate(specDir),
      });
      const cycleBudget = CycleBudget.derive({ maxRetries: cfg.maxRetries });
      const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 0 });
      // FIX D (judgment-day): mirrors src/pipeline.ts:2563-2564's keystone guard verbatim —
      // `generating && mode === "diff" && covPolicy.mode !== "off" && !triggerService`. This
      // conjunct deliberately omits `!input.triggerRepo` (unlike the measure-phase guard below,
      // which DOES respect it): the field now exists on RunQaInput (dual-judge cross-repo fix), but
      // this flag only ever WIDENS the FixLoop's safety net (disabling the filtered-retry
      // optimization) — a false positive here (treating a cross-repo run as if coverage will be
      // measured) is harmless, since coverage never actually gets undercounted for a run that never
      // measures it in the first place. Threading true PREVENTS the FixLoop's filtered-retry
      // optimization from scoping a retry to a subset of spec files when change-coverage WILL be
      // measured this run — filtering would silently undercount the keystone's own denominator (the
      // passing, non-retried specs' lines would look uncovered).
      const coverageWillMeasure = generating && input.mode === "diff" && cfg.coveragePolicyMode !== "off";
      // WS4 (full-flow remediation, 4.1): the INITIAL (pre-loop) generation's own spec source text —
      // `lastGenerated` is the LATEST generation attempt reaching this point (the static-fix loop's
      // own repair rounds, above, may have reassigned it; a run with no static-gate repairs reads the
      // very first `generated`). Seeds round 0's Lever-2 check (FixLoopInput.initialSpecSources' own
      // doc: "mirrors src/pipeline.ts's `result` local being ALREADY populated by the pre-loop
      // generation"). Absent when the GenerationPort adapter has no readSpecSource collaborator
      // wired — never fabricated.
      const initialSpecSources = lastGenerated.specSources;
      // WS4 (full-flow remediation, 4.1): the failure-point DOM snapshot for the FixLoop's regen
      // prompt, built ONCE from THIS run's initial failing cases (before any FixLoop round has
      // re-executed anything) — matches FixLoopInput.failureDomSnapshot's own doc ("a snapshot string
      // for the regen prompt"). Absent when none of the initial failing cases carried a failureDom.
      const failureDomSnapshot = buildFailureDomSnapshot(run.cases);
      const fixLoopResult = await fixLoop.run({
        initialRun: { verdict: run.verdict, cases: run.cases },
        isCode: cfg.isCode,
        generating,
        mode: input.mode,
        objectiveSource: [],
        maxRetries: cfg.maxRetries,
        cycleBudget,
        wallClockBudget,
        devHealthy,
        namespace: input.runId,
        coverageWillMeasure,
        ...(initialSpecSources?.length ? { initialSpecSources } : {}),
        ...(failureDomSnapshot ? { failureDomSnapshot } : {}),
        specDir: workspace.specDir,
      });
      run = { verdict: fixLoopResult.run.verdict, cases: fixLoopResult.run.cases, logs: run.logs };
      // FIX 3 (judgment-day D.7 batch 2): ACCUMULATE onto the shared `retries` counter (`+=`), not a
      // reassignment — the legacy's single module-scope `retries` variable is incremented by BOTH
      // the static-fix loop (src/pipeline.ts:2265) and the fix-loop (src/pipeline.ts:2723) onto the
      // SAME running total, never reset between them. A plain `retries = fixLoopResult.retries`
      // would silently DISCARD any repair rounds the static-fix loop already consumed above.
      retries += fixLoopResult.retries;
      // post-cutover-remediation P3 (unit 4): capture the FixLoop's own adjudicator verdict class —
      // undefined when the loop never reached the adjudicate() decision point (e.g. maxRetries:0, or
      // the loop condition never engaged at all), matching lastAdjudicatorVerdictClass's own
      // "never fabricated" contract above.
      lastAdjudicatorVerdictClass = fixLoopResult.lastAdjudicatorVerdict?.class;
      // WS3.1: capture the FULL verdict object (class + confidence + reason) at the SAME site, for
      // the publish() call site below.
      lastAdjudicatorVerdict = fixLoopResult.lastAdjudicatorVerdict;
    }

    // executedRed override (task #42): captured here, BEFORE the `if (run.verdict === "pass")`
    // guards below narrow `run.verdict` to the literal "pass" (TypeScript would otherwise flag the
    // override's own `run.verdict === "fail"` check as an unreachable-comparison error once inside
    // that narrowed block) — this is the run's FINAL, post-FixLoop verdict, widened back to the full
    // RunVerdict union so the override's condition (below, inside the review loop) type-checks
    // while still reading the SAME value `run.verdict` holds at review time.
    const finalRunVerdict: typeof run.verdict = run.verdict;

    // Phase: measure (ObjectiveSignalPort) — the keystone: unknown NEVER blocks. Consumed, never
    // re-implemented.
    let blocksPublish = false;
    let coverageRatio: number | null = null;
    // FIX 3 (judgment-day D.7): the value-oracle (mutation-testing) result the legacy persists
    // alongside coverageRatio (src/pipeline.ts:3267's persistOutcome(..., valueScore, ...),
    // src/qa/learning/labeler.ts's LabelerInput.valueScore) — previously hardcoded null in
    // toRunOutcome() below. Carried on the SAME ObjectiveSignalPort.measure() call (the objective-
    // signal keystone) rather than a second port, per the port-shape note this fix documents for
    // Task E.0's composition root. null when the port omits it (oracle not yet wired), never a
    // fabricated 0.
    let valueScore: number | null = null;
    if (run.verdict === "pass") {
      // FIX (judgment-day, cross-engine parity): the legacy runner only ever emits onStep("coverage")
      // inside its own `mode === "diff" && ... && !triggerService` gate (src/pipeline.ts:2912's
      // guard, mirrored exactly below) — a non-diff pass (complete/exhaustive/manual/context) or a
      // cross-repo diff pass never measures change-coverage at all in the legacy, so it must not
      // emit the step either. Previously this use-case emitted "coverage" on EVERY passing verdict
      // regardless of mode, a step the legacy engine never produces for those runs — a caller
      // mapping onStep -> RunRecord.step/RunEvents would show a "coverage" phase that never
      // genuinely measured anything.
      if (input.mode === "diff" && !input.triggerRepo) {
        this.deps.observer?.onStep("coverage");
      }
      // "Dynamic diff" precedent (classificationDiff, above): change-coverage is measured ONLY for a
      // per-commit DIFF run (src/pipeline.ts:2912's own gate: `mode === "diff" && ... && !triggerService`)
      // — classificationDiff is undefined outside diff mode (classify() is only called in diff mode,
      // see the classify() call site above), so passing it here already restricts measurement to diff
      // mode: every other mode calls measure() with `diff` absent, the adapter's assembler is never
      // invoked, and the keystone's own safe default (null -> "unknown" -> never blocks) applies —
      // exactly the legacy's mode gate, without duplicating a second `input.mode === "diff"` check.
      //
      // Cross-repo guard (dual-judge finding): legacy's coverage-collect gate is
      // `mode === "diff" && ... && !triggerService` (src/pipeline.ts:2912) — a webhook-triggered
      // cross-repo run's changed lines live in the SERVICE repo, which browser V8 coverage cannot
      // map (CLAUDE.md: "Change-coverage is unknown for these [cross-repo] runs"). Note legacy does
      // NOT gate the value-oracle (mutation testing, src/pipeline.ts's runOracle call, line ~722) on
      // triggerService — only the change-coverage ASSEMBLER is skipped. Reusing the same "starve the
      // diff arg" mechanism the mode gate above already relies on: passing `diff: undefined` here
      // means the assembler is never invoked (-> "unknown", never blocks) while the oracle inside the
      // adapter's own measure() implementation is untouched and still runs.
      if (input.triggerRepo) {
        // Mirror the legacy's explicit skip log (src/pipeline.ts:2909-2911) so a cross-repo run's
        // "unknown" coverage is diagnosable, never a silent null.
        console.log(`[qa] change-coverage: skipped — the changed lines live in ${input.triggerRepo}; browser coverage maps only the frontend (status=unknown).`);
      }
      // W4 fix (F2, audit-verified cutover blocker — "the dead value oracle"): this run's OWN
      // passing case names, mirroring the legacy's PER-RUN computation exactly
      // (src/pipeline.ts:731's `run.cases.filter(c=>c.status==="pass").map(c=>c.name)`) — this
      // block only ever runs when `run.verdict === "pass"` (the guard above), so `run.cases` here
      // IS the green baseline the fault-injection oracle needs to score against. Threaded as the
      // NEW optional trailing arg (see ObjectiveSignalPort.measure's own header) rather than left
      // for the composition root's static, always-empty `baselineCases: []` placeholder to supply.
      const baselineCases = run.cases.filter((c) => c.status === "pass").map((c) => c.name);
      // WS2.3 (full-flow remediation): runBlastRadius (built above from classificationIntent.
      // changedFiles) replaces the empty BlastRadius.of(input.sha, []) placeholder — see this
      // method's own comment at runBlastRadius's declaration for the full rationale.
      const signal = await this.deps.objectiveSignal.measure(
        runBlastRadius,
        workspace.specDir,
        input.triggerRepo ? undefined : classificationDiff,
        baselineCases,
      );
      coverageRatio = signal.ratio;
      valueScore = signal.valueScore ?? null;
      // FIX B (judgment-day, HIGH): blocksPublish must respect the policy mode — "unknown"/"pass"
      // never block either side of the mode, and "fail" blocks ONLY in "enforce" (src/qa/
      // change-coverage.ts:179-181's blocksPublish()). Unconditionally blocking on "fail" wrongly
      // held the PR in the default "signal" mode, contradicting CLAUDE.md's keystone contract.
      // post-cutover-remediation Constraint 3 (unit 5, task 5.5): consolidated onto
      // ObjectiveSignalPort.blocks() (unit 3) — the SAME DecideCoverageService.blocks() the adapter
      // already delegates to, never a second, independently re-implemented mode check.
      blocksPublish = this.deps.objectiveSignal.blocks(signal.status);

      // Phase: P2c (post-cutover-remediation, unit 5) — enforce-mode one-shot coverage regeneration.
      // Fires ONLY when: the first measure blocked publish, this is a diff-mode run whose changed
      // lines live in THIS repo (never a cross-repo trigger — browser coverage cannot map service-
      // repo lines, CLAUDE.md). Bounded by its OWN one-shot boolean slice (never the FixLoop's
      // cycleBudget/wallClockBudget — those gate FixLoop regeneration rounds, a DIFFERENT budget for
      // a DIFFERENT phase; reusing them here would let a FixLoop that already spent its budget
      // silently borrow more via this branch, or vice versa). `oneShotCoverageRegenUsed` is
      // structurally redundant TODAY (this whole "pass" branch runs at most once per run() call, with
      // no enclosing loop) — kept anyway, matching the design's explicit one-shot contract, so a
      // future refactor that loops this phase can never accidentally regenerate more than once. Any
      // regen throw propagates (CLAUDE.md: "surface integration errors loudly" — never swallowed into
      // a fabricated result); a validate-fail, non-pass rerun, or 0-spec regen all KEEP the first
      // measurement's blocksPublish untouched (never fabricated).
      let oneShotCoverageRegenUsed = false;
      if (blocksPublish && input.mode === "diff" && !input.triggerRepo && !oneShotCoverageRegenUsed) {
        oneShotCoverageRegenUsed = true;
        const gap = renderCoverageGap(signal.uncovered ?? []);
        // NOTE: the method's own abort AbortSignal parameter is shadowed within this block by the
        // `signal` local above (the ObjectiveSignalPort.measure() result) — this call omits it
        // (undefined, the port's own documented "backward compatible" default) rather than
        // introduce a renamed alias across this block's many existing `signal.*` reads.
        const regen = await this.deps.generation.generate([], workspace.specDir, undefined, classificationDiff, {
          ...baseEnrichment,
          coverageGap: gap,
        });
        if (regen.specs.length > 0) {
          const regenValidation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
          if (regenValidation.ok) {
            const regenNamespace = `${input.runId}-coverage-regen`;
            const regenRun = await this.deps.execution.execute(workspace.specDir, {
              ...liveExecutionOpts,
              namespace: regenNamespace,
            });
            if (regenRun.verdict === "pass") {
              const regenBaselineCases = regenRun.cases.filter((c) => c.status === "pass").map((c) => c.name);
              // GATE FIX (coordinator review): the re-measure MUST read the regen's OWN coverage
              // dumps — the SAME regenNamespace its own execute() call above just wrote them
              // under — never the composition-time namespace the FIRST measure() implicitly used.
              // Omitting this override silently re-reads the first run's stale dumps whenever the
              // regen produced genuinely new specs, making signal2/blocksPublish measure nothing new.
              // WS2.3 (full-flow remediation): runBlastRadius replaces the empty placeholder here
              // too — the SAME real BlastRadius the mainline measure() call above now uses.
              const signal2 = await this.deps.objectiveSignal.measure(
                runBlastRadius,
                workspace.specDir,
                classificationDiff,
                regenBaselineCases,
                { namespace: regenNamespace },
              );
              // Second measure wins — comparator-visible coverageRatio now reflects the regen's own
              // signal, never a stale first-run value.
              coverageRatio = signal2.ratio;
              blocksPublish = this.deps.objectiveSignal.blocks(signal2.status);
            }
          }
        }
      }
    }

    // Phase: review (ReviewPort).
    let reviewerApproved = true;
    // FIX 1 (judgment-day D.7 batch 2 — root-caused via bug-register Entry 12): the legacy's
    // persistOutcome closure (src/pipeline.ts:1114: `app.qa.needsReview && result ? result.approved
    // : null`) reads the MODULE-SCOPE `result` variable at EVERY exit site, regardless of verdict —
    // `result` is the raw AgentResult from the LAST generateOnce() call, which reviewGenerated()
    // returns UNCHANGED (its own `approved` field passed straight through) whenever
    // `!(app.qa.needsReview && deps.review)` (src/pipeline.ts:1620) is true, i.e. whenever
    // `deps.review` was never wired at all — reviewGenerated is then ALWAYS a no-op. So the legacy's
    // persisted reviewerApproved, for that (very common) fixture shape, IS GENERATION's OWN
    // self-reported approved flag — gated ONLY on needsReview + a generation result existing, NEVER
    // on verdict and NEVER on a genuine review call. RunQaUseCase's own review-call gate below
    // (`run.verdict==="pass" && cfg.needsReview`, a PRE-EXISTING condition from an earlier fix batch)
    // is architecturally correct for when a REAL ReviewPort genuinely runs in production — but it
    // structurally cannot produce a reviewerApproved value for a fail/flaky/invalid/infra-error/
    // skipped verdict, since review is never invoked on those paths. Default
    // reviewerApprovedForOutcome to generation's OWN approved flag (gated on needsReview alone,
    // matching the legacy's collapsed guard, and reusing the SAME value the two earlier terminal
    // exits above already compute — a single source of truth) BEFORE the genuine-review branch
    // below has a chance to overwrite it with the INDEPENDENT reviewer's own verdict on an actual
    // pass+review call.
    let reviewerApprovedForOutcome: boolean | undefined = reviewerApprovedFromGeneration;
    if (run.verdict === "pass" && cfg.needsReview) {
      // W2 fix (F3, reviewer-corrections regeneration loop — audit-verified cutover blocker): ports
      // the legacy's reviewGenerated() round loop VERBATIM (src/pipeline.ts:1608-1802). Legacy bounds
      // (re-verified against src/pipeline.ts:803 + the loop body, not invented here):
      //   MAX_REVIEW_ROUNDS = 2 (module-level const, src/pipeline.ts:803) — round indices 0 and 1.
      //   Round 0 reviews the initial (post-execute) specs.
      //   A parse miss (parsed:false) is NOT an actionable rejection — the legacy returns
      //     IMMEDIATELY with approved:false, WITHOUT burning a regeneration round (:1705-1714's own
      //     comment: "A parse miss is NOT an actionable rejection: feeding the synthetic correction
      //     back just burns a round and re-hits the same miss... failing closed (not burning a
      //     regeneration round)"). Distinct from GenerateTestsUseCase's OWN internal reviewer
      //     JSON-repair (a SEPARATE re-prompt-once-on-invalid-schema mechanism, generate-tests.
      //     use-case.ts:155-169) — that repairs `v.valid` (schema conformance) BEFORE a verdict is
      //     ever parsed; this loop's `parsed` is "did we get a parseable verdict AT ALL".
      //   The gate passes when `review.approved && blockingCount === 0` (:1773's `gateApproves`,
      //     Phase 4 + FIX 4 — both conditions required, an advisory-only correction never overrides
      //     an explicit approved:false). blockingCount defaults to corrections.length when absent
      //     (fail-closed: an unclassified correction counts as blocking).
      //   On rejection (`!gateApproves`) that is NOT the LAST round (round < MAX_REVIEW_ROUNDS - 1):
      //     regenerate with reviewCorrections threaded (the "Apply reviewer corrections HIGHEST
      //     priority" prompt section), then loop to the NEXT round with THIS round's corrections
      //     threaded into the reviewer's own priorCorrections (:1856's previousRoundCorrections
      //     assignment) so the reviewer can judge convergence.
      //   On rejection on the LAST round (round === MAX_REVIEW_ROUNDS - 1, i.e. round 1): TERMINAL —
      //     reviewerApproved stays false, no further regeneration (:1773's own early return).
      //   A regeneration that produces ZERO specs is a lost cause — the legacy returns approved:false
      //     immediately rather than reviewing an empty set again (:1607-1611's own round-0-vs-later
      //     distinction collapses here since this loop never re-enters with 0 specs from round 0,
      //     that path is the agent-no-op skip above; a LATER round losing all specs must still not
      //     silently inherit self-approval).
      const MAX_REVIEW_ROUNDS = 2;
      let reviewCases = run.cases;
      let previousRoundCorrections: string[] | undefined;
      // Plan 7-R W4: memoized per round the SAME way legacy's reviewGenerated() memoizes
      // (src/pipeline.ts:1625-1651's `lastSpecsKey`/`specsKey`) — re-capture DOM ONLY when the
      // reviewed spec set actually changed round-to-round, never on every round unconditionally.
      let reviewDomSnapshot: string | undefined;
      // Sentinel `undefined` (never a real key, even the EMPTY-cases key "") so round 0 always
      // captures at least once — a plain "" initial value would collide with an empty reviewCases
      // set's own key and silently skip round 0's capture entirely.
      let lastReviewSpecsKey: string | undefined;
      for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
        // [SWAP] absent ReviewDomGroundingPort -> reviewDomSnapshot stays undefined every round
        // (backward compatible — matches PreExecGroundingPort/PreGenerationGroundingPort's own
        // absent-collaborator posture). Best-effort: mirrors legacy's own `.catch(() => undefined)`.
        if (this.deps.reviewDomGrounding) {
          const specsForReview = reviewCases.map((c) => c.file ?? c.name);
          const specsKey = [...specsForReview].sort().join(",");
          if (specsKey !== lastReviewSpecsKey) {
            try {
              reviewDomSnapshot = await this.deps.reviewDomGrounding.capture(workspace.specDir, specsForReview, signal);
            } catch (err) {
              // FIX 1 (judgment-day W4 abort-plumbing): same ABORT-over-degraded-continue routing
              // as the pre-generation grounding call site above — an abort during capture must stop
              // the run, not silently fall back to an ungrounded review round.
              if (signal?.aborted) return this.abortedResult();
              console.error("[qa] WARNING: reviewer DOM grounding failed (non-fatal, review continues ungrounded):", err);
              reviewDomSnapshot = undefined;
            }
            lastReviewSpecsKey = specsKey;
          }
          if (signal?.aborted) return this.abortedResult();
        }
        const reviewResult = await this.deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
          ...baseReviewEnrichment,
          ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
          ...(reviewDomSnapshot ? { domSnapshot: reviewDomSnapshot } : {}),
        });
        // FIX A (judgment-day, HIGH) + F3 (legacy :1705-1714): parsed:false is a parse miss — NOT an
        // actionable rejection to re-prompt against, but ALSO never a free pass. Fails CLOSED
        // IMMEDIATELY, without burning a regeneration round (matches the legacy exactly — see the
        // header comment above).
        if (reviewResult.parsed === false) {
          reviewerApproved = false;
          break;
        }
        // executedRed override (task #42, dual-judge confirmed) — mirrors legacy's D4/#669-close
        // guard EXACTLY (src/pipeline.ts:1750-1755): "a reviewer LLM that receives evidence of a red
        // spec must not be allowed to approve it, even if the model returns approved:true." Legacy's
        // full shape is `round === 0 && executionEvidence?.verdict === "fail"`, where
        // executionEvidence is the D1-D5 feedback-execute phase's OWN pre-reviewer Playwright run
        // (pipeline.ts:2339-2432) — a SEPARATE execution, under a distinct `fbNs` namespace, run
        // BEFORE the verdictual Filter C execution specifically so the reviewer has real runtime
        // evidence to judge. That separate phase has NO counterpart here BY DESIGN, not by omission:
        // this use-case's review loop is only ever entered when `run.verdict === "pass"` (the outer
        // `if (run.verdict === "pass" && cfg.needsReview)` guard above) — review runs strictly AFTER
        // this run's own verdictual execute()+FixLoop have ALREADY produced `run`, so the runtime
        // evidence D1-D5 exists to manufacture is already in scope as `run.verdict` itself; a second,
        // separate pre-reviewer execution would be redundant duplicate work the D1-D5 phase's own
        // rationale (pipeline.ts:2339-2350's "the ~+15 min cost is justified") does not extend to
        // when the SAME evidence already exists for free.
        //
        // Because the outer guard already restricts entry to verdict==="pass", `run.verdict` here is
        // ALWAYS "pass" in every REACHABLE call — this override is DORMANT defense-in-depth under the
        // current architecture (mirrors this file's own pre-existing comment a few lines below: "the
        // executedRed guard... :1682-1692"), pinned by a stub-forced test (run-qa.use-case.test.ts)
        // that bypasses the outer guard to prove the override itself is correct should the review
        // loop ever become reachable on a non-pass verdict (e.g. a future D1-D5-equivalent phase).
        // Round-0-only, matching legacy's own stale-evidence guard: after the internal regen further
        // down the spec is fresh and unexecuted, so the override must not fire on round >= 1.
        const executedRed = round === 0 && finalRunVerdict === "fail";
        if (executedRed) {
          console.error("[qa] executedRed override (task #42, mirrors legacy D4/#669): the executed run was red — reviewer approval overridden fail-closed (round 0, known-red spec, no regeneration).");
          reviewerApproved = false;
          break;
        }
        const blockingCount = reviewResult.blockingCount ?? reviewResult.corrections.length;
        const gateApproves = reviewResult.approved && blockingCount === 0;
        reviewerApproved = gateApproves;
        if (gateApproves) break;
        // Rejected. Terminal on the LAST round — no further regeneration (mirrors legacy's
        // `if (round === MAX_REVIEW_ROUNDS - 1) return {...}`, :1773).
        if (round === MAX_REVIEW_ROUNDS - 1) break;
        retries++;
        this.deps.observer?.onStep("retry", `reviewer-correction round ${round + 1}/${MAX_REVIEW_ROUNDS}`);
        previousRoundCorrections = reviewResult.corrections;
        const regen = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
          ...baseEnrichment,
          reviewCorrections: reviewResult.corrections,
        });
        if (regen.specs.length === 0) {
          // A regeneration that produced no reviewable specs was never judged — it must NOT inherit
          // the generator's self-approval (mirrors legacy's round>0 empty-result guard, :1607-1611).
          reviewerApproved = false;
          break;
        }
        // The regenerated spec set was not re-executed against DEV by this loop (mirrors the
        // legacy's own reviewGenerated() contract: the reviewer judges the NEW spec text, execution
        // evidence is round-0-only per the executedRed guard, :1682-1692) — only the reviewed case
        // identity (file/name) changes for the NEXT round's review() call.
        reviewCases = regen.specs.map((file) => ({ name: file, file, status: run.cases[0]?.status ?? "pass" }));
      }
      // FIX 1 (judgment-day D.7 batch 2): a GENUINE review call's own verdict OVERWRITES generation's
      // self-approval default above — the independent reviewer's judgment always wins when it
      // actually ran, matching the legacy's real (non-no-op) reviewGenerated() path, which returns
      // `{...r, approved: reviewResult.approved}`-shaped results that DO feed back into `result`.
      reviewerApprovedForOutcome = reviewerApproved;
    }

    // Phase: decide (RunDecisionService). Mirrors the legacy runner's own normalization
    // (src/server/runner.ts: `step === "publish" ? "decide" : step`) — this use-case's publish
    // phase (below) never emits its OWN step; "decide" covers both, matching the legacy's single
    // observable step for the decide+publish pair.
    this.deps.observer?.onStep("decide");
    const evidence: RunEvidence = {
      verdict: run.verdict,
      generating,
      needsReview: cfg.needsReview,
      reviewerApproved,
      blocksPublish,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    };
    const decision = decide(evidence);

    // Phase: publish (PublicationPort).
    //
    // FIX F1 (audit, CRITICAL): every side-effect-bearing decision dispatches to the publish port —
    // not just "pr". Before this fix, ONLY sideEffect==="pr" ever called publish(), so a fail/invalid
    // verdict never opened a GitHub Issue, a flaky verdict never surfaced its quarantine outcome, and
    // a shadow-mode green run never logged — PublicationPortAdapter's own routing (decide -> pr/
    // issue/shadow-log/quarantine/noop, publication-port.adapter.ts:103-121) was built to handle all
    // of these but was simply never reached. "none" is the only sideEffect that still skips the call
    // (RunDecisionService already decided there is nothing to publish — e.g. an onFailure guard
    // suppressed the Issue, or a regression-green run with nothing new to publish; see this class's
    // own deriveErrorClass/decide() header for the onFailure precedence). This also closes FIX F2's
    // reconciliation gap: PublishDecisionService (workspace-and-publication) has no onFailure guard
    // of its own, but it can no longer be REACHED for an onFailure-suppressed verdict, because
    // RunDecisionService already resolved that case to "none" upstream of this gate — the adapter's
    // independent re-decision never runs for a case the decision layer already suppressed.
    //
    // Audit fix (judgment-day): thread the REAL per-run values this use-case already computed —
    // `reviewerApproved` (the review phase, above) and `blocksPublish` (the measure/coverage phase,
    // above) — into the publish decision, so PublicationPortAdapter's real PublishDecisionService
    // call reflects THIS run's outcome instead of silently falling back to a static composition-time
    // ctx that predates any run ever existing. Without this, a green-but-reviewer-rejected run could
    // still publish a PR, and an enforce-mode coverage failure could never hold one.
    //
    // e2eChanged: deliberately OMITTED — this use-case has no computed source for "did this run
    // change e2e/ files" anywhere in its ports (GenerationPort's own return shape carries no such
    // signal). Passing a fabricated value would be worse than falling back to the static ctx;
    // flagged as a gap for a follow-up rather than invented here.
    //
    // FIX F3 (CRITICAL, cross-repo Issue routing): mirrors legacy's `issueRepo = triggerService ?
    // triggerService.repo : app.repo` (src/pipeline.ts:1021) — a deploy-event run triggered by a
    // service repo must file its Issue in the TRIGGERING repo, the SAME repo input.triggerRepo
    // already names elsewhere in this method (the measure-phase cross-repo guard, above). Absent ->
    // the adapter falls back to its own static ctx.repo (the primary repo), unaffected.
    let publishOutcome: string | undefined;
    if (decision.sideEffect !== "none") {
      const published = await this.deps.publication.publish({
        verdict: run.verdict,
        cases: run.cases,
        logs: run.logs,
        reviewerApproved,
        coverageBlocks: blocksPublish,
        ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
        // WS3.1 (adjudication -> Issue body): thread the FixLoop's own last adjudicator verdict when
        // one exists (any fail path that actually ran the FixLoop) — absent for a clean first-try
        // pass or a run whose FixLoop never engaged, matching lastAdjudicatorVerdict's own "never
        // fabricated" contract (captured above, at the FixLoop call site).
        ...(lastAdjudicatorVerdict ? { adjudication: lastAdjudicatorVerdict } : {}),
      });
      publishOutcome = published.outcome;
    }

    // Phase: persist (RunHistoryPort) + fold (LearningPort).
    //
    // FIX 2 (judgment-day D.7): a CLEAN context-mode pass must NOT reach EITHER call — matches the
    // legacy's "Flag 3" convention exactly: buildContextMap's own mode==="context" branch (src/
    // pipeline.ts:1445-1448) returns immediately (`return built.run ?? resultOf(ns, "pass", ...)`),
    // never falling through to persistOutcome (:3267) OR foldRunLearning (:3271) at all — both live
    // much later in the function body, in code this early return never reaches. This is distinct
    // from every OTHER context-mode outcome (e.g. context-invalid, which reaches
    // terminalResult("invalid", ...) above and DOES persist+fold, exactly like any other mode's
    // static-gate failure) — only the CLEAN pass is exempted from BOTH calls.
    const isContextCleanPass = input.mode === "context" && decision.verdict === "pass";
    // FIX 1 / FIX 3 / FIX 4 (judgment-day D.7): derive errorClass/gateValueScore ONCE here (via the
    // shared deriveErrorClass helper below) and reuse the SAME values both for the persisted
    // RunOutcome (toRunOutcome, below) and for the RunQaResult this method returns — so
    // RewrittenOrchestratorAdapter's toOutcome() mirrors EXACTLY what was persisted, never a second,
    // independently-derived (and potentially drifting) computation.
    const gateValueScore = valueScore;
    const errorClass = this.deriveErrorClass(decision.verdict, coverageRatio, gateValueScore);
    let mainlineOutcome: RunOutcome | undefined;
    if (!isContextCleanPass) {
      mainlineOutcome = this.toRunOutcome(input, decision, run.cases, retries, coverageRatio, errorClass, {
        // Legacy parity: the mainline persists the REAL static-gate result (the same value the
        // returned RunQaResult.gateSignals.static carries below) — see toRunOutcome's staticOk doc.
        staticOk: validation.ok,
        reviewerApproved: reviewerApprovedForOutcome,
        valueScore: gateValueScore,
        // FIX F1: the publish outcome string (e.g. "pr: <url>", "issue: <url>", "quarantine: ...",
        // "shadow: ...", "noop: ...") reaches the persisted RunOutcome so a run's publish result is
        // diagnosable from the run record alone — never fabricated when publish() was never called
        // (decision.sideEffect === "none").
        ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
        // W3 F2 (legacy parity: src/pipeline.ts:3267's persistOutcome(..., rulesRetrieved:
        // retrievedRuleIds, ...) — the ONLY persistOutcome call site that threads it): the retrieved
        // rule IDS (WS1.1 fix — was trigger text) reach the persisted RunOutcome on the mainline
        // exit only.
        ...(retrievedRuleIds.length ? { rulesRetrieved: retrievedRuleIds } : {}),
        // Plan 7-R B5.3 (leak 3 fix): the pre-exec grounding gate's real, run-level accumulated
        // counters — replaces the hardcoded 0 the persisted RunOutcome carried before this gate
        // existed (mirrors legacy's persistOutcome() reading its own module-scope accumulators,
        // src/pipeline.ts:1134-1140).
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
        // Slice B (structural-signals-expansion, design §2/ADR-B): advisory structural-signal
        // calibration telemetry. structuralSignalBytes is gated on blastRadiusSignal itself being
        // non-empty (mirrors the section's own render-gating — an empty render means nothing to
        // report, not "0 bytes of something"). serviceLinksCount/contractDriftCount are gated on
        // this.deps.serviceLinks's PRESENCE (the resolver being wired), not a truthy count — so 0
        // honestly means "resolver ran, found none", distinguishable from "no resolver wired".
        ...(blastRadiusSignal ? { structuralSignalBytes: Buffer.byteLength(blastRadiusSignal, "utf8") } : {}),
        ...(this.deps.serviceLinks
          ? { serviceLinksCount: resolvedServiceLinks.length, contractDriftCount: resolvedContractDrift.length }
          : {}),
        // Slice C (structural-signals-expansion, design §3.8): the fourth telemetry field, added by
        // THIS slice's own commit. Same "gated on the collaborator's PRESENCE, not a truthy count"
        // discipline Slice B established — but crossRepoImpact only ever RUNS on a cross-repo run
        // with a matching link (the cheap pre-filter above), so gating on the RESULT (not the
        // collaborator's presence) is correct here: a same-repo run must stay undefined (the
        // collaborator never ran), not report a fabricated 0.
        ...(crossRepoImpact ? { crossRepoImpactedCount: crossRepoImpact.impactedLinks.length } : {}),
        // W3 F3: the execution logs ExecutionPort.execute() already returned — reaches the
        // persisted RunOutcome the SAME way cases does (see toRunOutcome's own cases doc).
        logs: run.logs,
        // post-cutover-remediation P3 (unit 4): the FixLoop's own adjudicator verdict class, captured
        // above when the loop engaged — undefined for a clean first-try pass.
        adjudicationClass: lastAdjudicatorVerdictClass,
      });
      await this.deps.runHistory.save(mainlineOutcome);

      // Phase: fold (LearningPort) — off-path by contract: never gates the verdict, failures are
      // swallowed at the port's own boundary (not this use-case's concern to catch). post-cutover-
      // remediation P3 (unit 4): gated on shouldDistillLearning, now ALSO reading the persisted
      // outcome's own adjudication class — app_defect (the adjudicator attributing the failure to
      // the app, not the generated test) suppresses the fold so the flywheel never learns to weaken
      // a test that correctly caught a real bug.
      if (shouldDistillLearning(cfg.isCode, decision.verdict, mainlineOutcome.adjudication?.class)) {
        await this.deps.learning.fold(mainlineOutcome);
      }

      // reflector-rewire (design ADR-1): the reflect gate ANDs further conditions on top of the SAME
      // shouldDistillLearning(...) boolean the fold above just used (reused, never re-derived) —
      // verdict !== "flaky" AND errorClass not in {E-INFRA, E-FLAKY}. This is a DELIBERATE
      // fold-vs-reflect asymmetry (legacy parity, explore #1082): a flaky/E-INFRA/E-FLAKY run is
      // allowed to feed the deterministic governance fold (unchanged above) but must NEVER author an
      // LLM reflection rule from environmental noise (Goodhart). [SWAP]-optional: absent
      // `deps.reflector` is a no-op, zero behavior change (mirrors every other optional collaborator
      // in this use-case). Fault-isolated by the adapter itself — no extra try/catch here.
      //
      // WS1.2 (full-flow remediation): a FIFTH condition — mainlineOutcome.errorClass must be a real,
      // non-empty class. Before this fix, a clean green run (errorClass:null via
      // errorClassFromVerdict's own `case "pass": ... return null`) satisfied every other condition
      // above (shouldDistillLearning(false,"pass",undefined) === true; verdict !== "flaky"; null is
      // neither "E-INFRA" nor "E-FLAKY"), so EVERY healthy green run reached reflect() — burning a
      // reflector session against a failure-framed prompt and minting an unfalsifiable
      // errorClass:"" candidate rule (WS1.4a closes the credit-earning side; this closes the
      // ledger-pollution/prompt-budget side at the source). `!== ""` is defensive belt-and-braces
      // alongside `!= null` — resolveErrorClass never actually returns "", but a reflect gate must
      // never treat a falsy-but-defined class as "qualifying" either. Fold-on-green is UNCHANGED
      // (prevention credit on a clean run is the designed promotion signal) — only reflect requires
      // a genuine, taxonomy-derived failure class to fire on.
      if (
        this.deps.reflector &&
        shouldDistillLearning(cfg.isCode, decision.verdict, mainlineOutcome.adjudication?.class) &&
        decision.verdict !== "flaky" &&
        mainlineOutcome.errorClass !== "E-INFRA" &&
        mainlineOutcome.errorClass !== "E-FLAKY" &&
        mainlineOutcome.errorClass != null &&
        mainlineOutcome.errorClass !== ""
      ) {
        await this.deps.reflector.reflect(this.toReflectionInput(mainlineOutcome));
      }
    }

    this.deps.observer?.onStep("done");
    return {
      decision,
      errorClass,
      // Determinism fix: return the EXACT persisted outcome (see RunQaResult.outcome's own doc).
      ...(mainlineOutcome ? { outcome: mainlineOutcome } : {}),
      // FIX F1: surface the SAME publish outcome on the returned RunQaResult (mirrors the persisted
      // RunOutcome above) — so a caller with no read-back path on RunHistoryPort (e.g.
      // RewrittenOrchestratorAdapter's toOutcome()) can still report what publish() actually did.
      ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
      // W3 F2: mirrors the SAME isContextCleanPass gate the persisted mainlineOutcome above uses —
      // a clean context pass never persists (see isContextCleanPass above), so its returned
      // RunQaResult must not report retrieved rules either (nothing was genuinely persisted).
      // WS1.1: retrievedRuleIds (not trigger text) — see this file's own retrieve() call-site doc.
      rulesRetrieved: isContextCleanPass ? [] : retrievedRuleIds,
      gateSignals: {
        // FIX 2 (judgment-day D.7 batch 2): a CLEAN context-mode pass never persists a real
        // RunOutcome at all (see isContextCleanPass above) — the legacy's own comparator counterpart
        // (LegacyPipelineAdapter's synthesizeContextOutcome(), used whenever no genuine outcome was
        // ever saved) hardcodes `static: false` as its placeholder, since there is no real static-gate
        // telemetry worth reporting for a run that was never persisted. Reporting the raw
        // validation.ok here would surface an artifact of this composition's own internal generic
        // ValidationPort call (which the use-case still runs for context mode per its own documented
        // scope note) rather than the legacy's true "nothing was persisted" signal.
        static: isContextCleanPass ? false : validation.ok,
        coverageRatio,
        valueScore: gateValueScore,
        // FIX 2 (judgment-day D.7 batch 2): the SAME synthesizeContextOutcome() placeholder carries
        // no reviewerApproved key at all (unmasked by the `static` fix above — this field's own
        // divergence was previously hidden behind it) — a clean context pass must not report a
        // reviewerApproved value either, matching the legacy's "nothing was genuinely persisted" gap.
        ...(!isContextCleanPass && reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries,
        // Plan 7-R B5.3 (leak 3 fix): real, run-level accumulated counters — mirrors the SAME values
        // just persisted into mainlineOutcome above (a caller with no read-back path on
        // RunHistoryPort, e.g. RewrittenOrchestratorAdapter's toOutcome(), still sees them here).
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
      },
      cases: run.cases,
      // W3 F3: the execution logs ExecutionPort.execute() (or the context-mode synthetic run,
      // which carries generated.note as its own "logs" per the branch above) already produced.
      logs: run.logs,
    };
  }

  // FIX 4 (judgment-day D.7): shared errorClass derivation via the re-ported labeler taxonomy
  // (domain/helpers/error-class.ts's resolveErrorClass — a VERBATIM port of src/qa/learning/
  // labeler.ts's resolveErrorClass + src/qa/learning/taxonomy.ts), matching the legacy's
  // labelRunOutcome() call exactly. reviewerCorrections stays [] (not yet threaded into this
  // use-case's gateSignals — an undeclared, separate gap from the 5 CONFIRMED divergences this fix
  // batch closes), so the reviewer-correction-derived classes never fire at this layer; the
  // verdict/coverage/value-score bands (E-STATIC/E-EXEC-FAIL/E-FLAKY/E-INFRA/E-COVERAGE-GAP/
  // E-VALUE-SURVIVED) are fully derived.
  private deriveErrorClass(verdict: string, coverageRatio: number | null, valueScore: number | null): string | null {
    return resolveErrorClass({
      verdict,
      coverageRatio,
      minCoverageRatio: DEFAULT_MIN_COVERAGE_RATIO,
      reviewerCorrections: [],
      valueScore,
    });
  }

  // reflector-rewire (design ADR-4): builds the NARROW ReflectionInput projection SOLELY from an
  // already-computed, already-persisted RunOutcome — no repo reads, no additional derivation. This
  // is the ONLY place a RunOutcome is narrowed for the reflector; RunOutcome.logs/note are
  // STRUCTURALLY unreachable from the result (ReflectionInput has no such fields), so a reflection
  // prompt can never leak raw execution logs or diagnostic notes even if the adapter's own prompt
  // builder were later widened.
  private toReflectionInput(outcome: RunOutcome): ReflectionInput {
    return {
      runId: outcome.runId,
      app: outcome.app,
      sha: outcome.sha,
      mode: outcome.mode,
      verdict: outcome.verdict,
      // ReflectionInput.errorClass is the narrow (non-null) ErrorClass alias — outcome.errorClass is
      // the kernel's WIDE `string | null`. A null errorClass means "healthy green, no taxonomy
      // label" (see error-class.ts's own errorClassFromVerdict, `case "pass": ... return null`) —
      // WS1.2 (full-flow remediation) CORRECTS this doc's prior claim that "every reachable verdict
      // on that path yields a non-null class": that was PROVABLY FALSE for a clean pass with
      // coverageRatio null or >= the minimum ratio, which resolves errorClass:null while still
      // satisfying every OTHER pre-WS1.2 reflect-gate condition (shouldDistillLearning is true for a
      // pass; verdict !== "flaky"; null is neither "E-INFRA" nor "E-FLAKY") — so a null errorClass
      // DID reach this projection on every clean green run, until WS1.2 added the explicit
      // `errorClass != null && errorClass !== ""` conjunct to both reflect gate call sites (mainline,
      // above; terminal, below), which now genuinely guarantees a non-null/non-empty class by the
      // time toReflectionInput() is ever invoked. Coalesce to "" defensively rather than widen the
      // port's own declared type — belt-and-braces only, structurally unreachable post-WS1.2.
      errorClass: outcome.errorClass ?? "",
      gateSignals: {
        static: outcome.gateSignals.static,
        coverageRatio: outcome.gateSignals.coverageRatio,
        valueScore: outcome.gateSignals.valueScore,
        reviewerCorrections: outcome.gateSignals.reviewerCorrections,
        flaky: outcome.gateSignals.flaky,
        retries: outcome.gateSignals.retries,
      },
    };
  }

  private toRunOutcome(
    input: RunQaInput,
    decision: RunDecision,
    cases: QaCase[],
    retries: number,
    coverageRatio: number | null,
    errorClass: string | null,
    // FIX 1 / FIX 3 (judgment-day D.7): reviewerApproved and valueScore are OPTIONAL overrides — the
    // early-exit callers (skippedResult/terminalResult/agent no-op skip) never reach the review or
    // measure phases, so they omit both (matching the legacy's own persistOutcome calls for those
    // sources, which never thread a reviewerApproved/valueScore either — see src/pipeline.ts:1114's
    // `app.qa.needsReview && result ? result.approved : null`, where `result` stays unset before
    // review runs). Only the mainline persist call (after review/measure) supplies real values.
    //
    // W3 F2: rulesRetrieved mirrors the SAME asymmetry — legacy's persistOutcome() (src/pipeline.ts:
    // 1100-1124) only ever threads `overrides.rulesRetrieved: retrievedRuleIds` at ITS OWN mainline
    // call site (pipeline.ts:3267); every other persistOutcome call (skipped/invalid/infra-error,
    // pipeline.ts:2233/2309/2315/2334/2473/2479/2506) omits the override entirely, so
    // labelRunOutcome's own hardcoded `rulesRetrieved: []` (labeler.ts:45) is what actually persists
    // for those exits — retrieval happened (or was attempted) but the run never reached a state
    // whose learning is worth crediting. Optional here for the exact same reason: only the mainline
    // caller below passes it; every other toRunOutcome() call site omits it and gets [].
    // Plan 7-R B5.3 (leak 3 fix): the pre-exec grounding gate's real counters — OPTIONAL, same
    // asymmetry as reviewerApproved/valueScore above: every caller that reaches this helper AFTER
    // the gate has run (the mainline path, and terminalResult's invalid/infra-error exits that fire
    // post-generate) threads the REAL accumulated values; a caller that exits before the gate could
    // ever run (skippedResult's no-op skip, the classify-skip bare return, infraErrorResult's
    // pre-generation entry-gate/setup failures) omits them and gets the literal 0 default below —
    // never fabricated, exactly the same "0 not undefined" contract this use-case's own header
    // documents for these fields.
    extra?: {
      // Legacy persistOutcome's `overrides?.staticOk ?? false` (see the gateSignals.static note
      // below) — only callers whose path genuinely passed the static gate thread true.
      staticOk?: boolean;
      reviewerApproved?: boolean;
      valueScore?: number | null;
      note?: string;
      rulesRetrieved?: string[];
      preExecAmbiguityCatches?: number;
      deterministicSelectorBlocks?: number;
      catalogGateInWindow?: number;
      catalogGateAdvisory?: number;
      catalogGateFailClosed?: number;
      // Slice B (structural-signals-expansion, design §2/ADR-B): advisory structural-signal
      // calibration telemetry. Optional, same "never ran" asymmetry as catalogGate* above at the
      // TYPE level — but see the gateSignals literal below for the DELIBERATE departure at the
      // construction site (conditional-spread, not `?? 0`).
      structuralSignalBytes?: number;
      serviceLinksCount?: number;
      contractDriftCount?: number;
      // Slice C (structural-signals-expansion, design §3.8): the fourth telemetry field, added by
      // THIS slice's own commit — same "never ran" asymmetry at the TYPE level, same DELIBERATE
      // conditional-spread departure at the construction site below.
      crossRepoImpactedCount?: number;
      // W3 F3: the execution logs, same optional-override precedent as note/rulesRetrieved above —
      // only the mainline caller (post-execute) has real logs to thread.
      logs?: string;
      // post-cutover-remediation P3 (unit 4): the FixLoop's own adjudicator verdict class — only the
      // mainline caller (post-FixLoop) has a real value to thread; every other toRunOutcome() call
      // site (skipped/invalid/infra-error, all pre-FixLoop) omits it and gets undefined, matching
      // this field's own kernel-level "never fabricated" contract.
      adjudicationClass?: string;
    },
  ) {
    const gateCoverageRatio = coverageRatio;
    const gateValueScore = extra?.valueScore ?? null;
    return {
      runId: input.runId,
      app: input.app,
      sha: input.sha.toString(),
      mode: input.mode,
      target: input.target,
      verdict: decision.verdict,
      errorClass,
      gateSignals: {
        // Legacy parity (exposed by the determinism fix — the persisted-vs-returned identity made
        // the goldens finally see the PERSISTED shape): legacy's persistOutcome defaults
        // `overrides?.staticOk ?? false` (src/pipeline.ts:1100 region) — a hardcoded `true` here
        // wrote static:true into the store for every skipped/invalid/infra-error outcome where
        // legacy persists false. Callers pass the REAL per-path value (mainline: validation.ok;
        // terminal: the evidence's own static; skipped: default false).
        static: extra?.staticOk ?? false,
        coverageRatio: gateCoverageRatio,
        valueScore: gateValueScore,
        reviewerCorrections: [],
        ...(extra?.reviewerApproved !== undefined ? { reviewerApproved: extra.reviewerApproved } : {}),
        flaky: decision.verdict === "flaky",
        retries,
        preExecAmbiguityCatches: extra?.preExecAmbiguityCatches ?? 0,
        deterministicSelectorBlocks: extra?.deterministicSelectorBlocks ?? 0,
        catalogGateInWindow: extra?.catalogGateInWindow ?? 0,
        catalogGateAdvisory: extra?.catalogGateAdvisory ?? 0,
        catalogGateFailClosed: extra?.catalogGateFailClosed ?? 0,
        // Slice B (structural-signals-expansion, design §2/ADR-B): conditional-spread (NOT `?? 0`,
        // deliberately) — true undefined survives when extra? never carried the field, so "never
        // ran" stays distinguishable from "ran and found zero". This is the exact construction-site
        // fix a prior design revision was missing: the fields were typed+mapped for persistence but
        // never read back out of extra? into this literal, so they never reached a returned/
        // persisted RunOutcome at all.
        ...(extra?.structuralSignalBytes !== undefined ? { structuralSignalBytes: extra.structuralSignalBytes } : {}),
        ...(extra?.serviceLinksCount !== undefined ? { serviceLinksCount: extra.serviceLinksCount } : {}),
        ...(extra?.contractDriftCount !== undefined ? { contractDriftCount: extra.contractDriftCount } : {}),
        // Slice C (structural-signals-expansion, design §3.8): the fourth telemetry field, THIS
        // slice's own commit — same conditional-spread discipline as the three Slice B fields above.
        ...(extra?.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: extra.crossRepoImpactedCount } : {}),
      },
      rulesRetrieved: extra?.rulesRetrieved ?? [],
      ...(extra?.note !== undefined ? { note: extra.note } : {}),
      at: new Date().toISOString(),
      // W3 F3 (HIGH cutover blocker): persist the SAME per-case results + logs the returned
      // RunQaResult carries (mirrors `note`'s own precedent) — keeps toRunOutcome() (the persisted
      // shape) and RewrittenOrchestratorAdapter's toOutcome() (the returned shape) STRUCTURALLY
      // IDENTICAL, the invariant rewritten-orchestrator.adapter.test.ts's own "returns the SAME
      // RunOutcome shape RunHistoryPort.save receives" pin enforces. cases is only ever non-empty
      // when a real execute() happened (mainline path); every other caller passes [] (unchanged).
      cases,
      ...(extra?.logs !== undefined ? { logs: extra.logs } : {}),
      // post-cutover-remediation P3 (unit 4): conditional-spread (never a fabricated placeholder) —
      // only threaded when the caller's FixLoop genuinely produced a verdict class.
      ...(extra?.adjudicationClass !== undefined ? { adjudication: { class: extra.adjudicationClass } } : {}),
    };
  }

  private skippedResult(
    // FIX 1 (judgment-day D.7 batch 2): only the AGENT-NO-OP skip caller passes a value here — the
    // legacy's persistOutcome closure reads `result.approved` there too (src/pipeline.ts:2233's
    // persistOutcome(skipped, ...) call, same guard as every other exit site). The CLASSIFY-skip
    // source stays undefined (its own bare-return, no-persist convention per FIX E is unaffected —
    // it never reaches persistOutcome at all, so it never computes a reviewerApproved value either).
    reviewerApprovedForOutcome?: boolean,
  ): RunQaResult {
    this.deps.observer?.onStep("done");
    return {
      decision: RunDecision.of("skipped", "none"),
      // FIX 4 (judgment-day D.7): "skipped" always resolves errorClass:null via the taxonomy
      // (errorClassFromVerdict's own `case "skipped": return null` — skipped runs teach nothing).
      errorClass: this.deriveErrorClass("skipped", null, null),
      gateSignals: {
        static: false,
        coverageRatio: null,
        valueScore: null,
        ...(reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries: 0,
        preExecAmbiguityCatches: 0,
        deterministicSelectorBlocks: 0,
        catalogGateInWindow: 0,
        catalogGateAdvisory: 0,
        catalogGateFailClosed: 0,
      },
      cases: [],
      // W3 F2: legacy parity — neither skip source (classify-skip, agent-no-op) ever threads
      // retrievedRuleIds into persistOutcome's overrides (src/pipeline.ts:2233's persistOutcome(
      // skipped, ...) call omits it), so the persisted (or never-persisted) outcome is always [].
      rulesRetrieved: [],
    };
  }

  // CLAUDE.md invariant ("surface integration errors loudly — never swallow errors into an empty
  // result"): every infra-error-shaped terminal routes through here with a diagnostic `note` — a
  // silent infra-error (verdict + nothing else) is undiagnosable from the run record alone. Logs
  // loudly via console.error so the failure is visible even when the caller never inspects `note`.
  private infraErrorResult(note?: string): RunQaResult {
    if (note !== undefined) {
      console.error("[qa] infra-error terminal:", note);
    }
    this.deps.observer?.onStep("done");
    return {
      decision: RunDecision.of("infra-error", "none"),
      // FIX 4 (judgment-day D.7): the entry-gate infra-error never persists (matches the legacy,
      // which throws/returns before persistOutcome is reachable), but errorClass is still derived
      // consistently via the SAME taxonomy for internal consistency of this returned RunQaResult.
      errorClass: this.deriveErrorClass("infra-error", null, null),
      gateSignals: { static: false, coverageRatio: null, valueScore: null, retries: 0, preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 },
      cases: [],
      rulesRetrieved: [],
      ...(note !== undefined ? { note } : {}),
    };
  }

  // Plan 7.1 (engram #913) — the aborted-terminal mapping. A cancelled run is NOT a real failure to
  // teach the learner from: it maps to the SAME shape infraErrorResult() already returns
  // (verdict:"infra-error", sideEffect:"none", never persisted) because that is EXACTLY what
  // cancelTrackedRun (src/server/runner.ts) already writes when it finalizes a cancelled record
  // (verdict:"infra-error", note:"cancelled by operator") — reusing the existing terminal shape
  // keeps both engines' cancellation outcome byte-identical rather than inventing a new verdict.
  // Deliberately calls infraErrorResult() with NO note: the runner (src/server/runner.ts's
  // cancelTrackedRun) writes its OWN "cancelled by operator" note onto the run record when it
  // finalizes a cancellation — threading a note here would clash with (or be silently overwritten
  // by) that operator-facing note. Absent note on THIS specific terminal is intentional, not an
  // oversight of the loud-diagnostics fix applied to every other infra-error-shaped terminal.
  private abortedResult(): RunQaResult {
    return this.infraErrorResult();
  }

  // FIX E (judgment-day): persist/fold on the two terminal early-exits this helper serves,
  // matching each legacy source EXACTLY (both save; only "invalid" also folds):
  //   invalid     (src/pipeline.ts:2313-2325) -> persistOutcome save YES, foldRunLearning save YES
  //   infra-error (src/pipeline.ts:2328-2337) -> persistOutcome save YES, foldRunLearning save NO
  private async terminalResult(
    verdict: "invalid" | "infra-error",
    cfg: RunQaConfig,
    input: RunQaInput,
    ev: { generating: boolean; static: boolean },
    // FIX 1 (judgment-day D.7 batch 2): both terminal exits this helper serves happen AFTER
    // generation has already run (static-gate invalid: post-generate/pre-execute; mid-run
    // infra-error: post-validate/pre-execute) — so the SAME generation-sourced reviewerApproved
    // default (cfg.needsReview ? generated.approved : undefined) applies here exactly as it does on
    // the mainline path, matching the legacy's verdict-independent persistOutcome guard
    // (src/pipeline.ts:1114) for these two exit sources too.
    reviewerApprovedForOutcome?: boolean,
    // FIX 2 (judgment-day D.7 batch 2 — bug-register Entry 12's newly-found context-invalid gap):
    // set ONLY by the context-mode invalid caller. The legacy's context-mode invalid-context.json
    // branch (src/pipeline.ts:1377-1404's buildContextMap) files an Issue via issueOrShadow() then
    // returns resultOf(ns, "invalid", ...) WITHOUT EVER CALLING persistOutcome — this is a DISTINCT,
    // context-specific validateContextFn failure, not the generic static-gate invalid every OTHER
    // mode's terminalResult("invalid", ...) call correctly persists. Skips BOTH runHistory.save()
    // AND learning.fold() (mirroring FIX 2's own established no-persist convention for the clean
    // context pass, which ALSO skips both calls per src/pipeline.ts:1445-1448's early return).
    //
    // Deliberate divergence (judgment-day W3, FIX 2, judge B): legacy's buildContextMap invalid
    // branch calls issueOrShadow() DIRECTLY (src/pipeline.ts:1377-1404) — bypassing report()'s own
    // `onFailure !== "github-issue"` top-guard (src/pipeline.ts:3337-3340) entirely, so a
    // context-mode invalid run files a real Issue even when the app is configured with
    // onFailure:"none". No comment or test anywhere in the legacy source explains this as
    // deliberate; it reads as an accident of buildContextMap having been written as its own
    // self-contained branch before/independent of report()'s onFailure guard, never wired through
    // report() the way every other verdict-reporting call site (fail/invalid/infra-error/flaky) is.
    // This composition's context-mode invalid ALSO reaches terminalResult("invalid", ...) (same
    // call site as the generic static-gate invalid, input.mode === "context" below) — which now
    // (FIX 1, above) dispatches through the SAME decide()-derived sideEffect every other invalid
    // verdict uses, i.e. it DOES honor onFailure. This is a deliberate choice to prefer the
    // consistent, already-ported policy (run-decision.service.ts's reportSideEffect, itself a
    // faithful port of report()'s guard) over reproducing an undocumented legacy bypass — CLAUDE.md
    // "root-cause, not app-specific" favors one coherent publish policy over a second, silent
    // exception carved out for one mode. If this divergence is ever found to be load-bearing
    // (e.g. a team relies on context-mode Issues firing regardless of onFailure), reproduce the
    // bypass explicitly here with its own comment — do not let it drift back in silently.
    skipPersist = false,
    // FIX 3 (judgment-day D.7 batch 2): the static-fix loop's own accumulated `retries` (repair
    // rounds consumed before landing on this "invalid" exit — src/pipeline.ts:2265's `retries++`)
    // was PREVIOUSLY hardcoded to the literal 0 here (both in the persisted outcome and this
    // method's own returned RunQaResult), invisible before the static-fix loop existed (retries was
    // ALWAYS 0 for these two call sites until FIX 3 ported the loop). Now genuinely threaded.
    retries = 0,
    // CLAUDE.md invariant ("surface integration errors loudly"): a diagnostic note for THIS terminal
    // exit — e.g. the validation-infra route's joined error messages, or the health pre-flight's
    // captured InfraError message. Optional; omitted entirely when the caller has nothing more
    // specific than the verdict itself (the generic static-gate "invalid" callers, whose own errors
    // already reach the caller via ValidationPort's separate `errors` array elsewhere).
    note?: string,
    // Plan 7-R B5.3 (leak 3 fix): the pre-exec grounding gate's real, run-level accumulated counters
    // — BOTH call sites of this helper (static-gate invalid, health-preflight infra-error) fire AFTER
    // the gate has already run (W1's one-shot pass always runs before validate; W2's re-check runs
    // right after the static-fix loop settles), so both genuinely have real values to thread. Defaults
    // to all-zero for callers that predate this fix (backward compatible; never fabricated for a
    // caller that legitimately has nothing to report).
    groundingSignals: {
      preExecAmbiguityCatches: number;
      deterministicSelectorBlocks: number;
      catalogGateInWindow: number;
      catalogGateAdvisory: number;
      catalogGateFailClosed: number;
    } = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 },
    // WS1.6 (full-flow remediation): the retrieved rule IDS (WS1.1's `retrievedRuleIds` local) — BOTH
    // call sites of this helper (static-gate invalid, mid-run health-preflight infra-error) fire
    // strictly AFTER learning.retrieve() has already run (retrieval happens once, before the first
    // generate() call, ordered ahead of both the static-fix loop and the health pre-flight), so both
    // genuinely have real ids to thread — unlike groundingSignals above, this is NOT gated on a
    // per-caller "did the gate run" question, it is gated on "did retrieval run", which is ALWAYS
    // true by the time either call site is reached. Defaults to [] for a caller that predates this
    // fix (backward compatible) and is also the correct value for any FUTURE terminal exit that
    // fires before retrieval — never a fabricated non-empty array.
    rulesRetrieved: string[] = [],
  ): Promise<RunQaResult> {
    const decision = decide({
      verdict,
      generating: ev.generating,
      needsReview: cfg.needsReview,
      reviewerApproved: true,
      blocksPublish: false,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    });
    // FIX 4 (judgment-day D.7): both "invalid" and "infra-error" resolve to their own structural
    // errorClass (E-STATIC / E-INFRA respectively) via the taxonomy, matching the legacy's
    // errorClassFromVerdict exactly for these two verdict-derived classes.
    const errorClass = this.deriveErrorClass(verdict, null, null);
    // FIX 1 (judgment-day W3, CRITICAL): dispatch the SAME publish call the mainline handle()/run()
    // body makes (see the "Phase: publish" block above, ~line 765-809) — this helper previously
    // computed `decision` (including its derived sideEffect) but NEVER called
    // this.deps.publication.publish(), so a static-gate "invalid" run (onFailure: "github-issue")
    // never actually opened a GitHub Issue, and a shadow-mode invalid run never logged. Legacy
    // parity: pipeline.ts:2313-2325 (static-gate invalid -> report() -> issueOrShadow -> a real
    // Issue "QA could not validate the generated E2E tests at ${sha}"). "infra-error" resolves to
    // sideEffect "none" via decide() itself (legacy never opens an Issue for infra-error,
    // report():3353-3355) — so infra-error call sites stay no-publish AUTOMATICALLY through the
    // shared decision, without any verdict-specific branching here.
    let publishOutcome: string | undefined;
    if (decision.sideEffect !== "none") {
      const published = await this.deps.publication.publish({
        verdict,
        cases: [],
        logs: note ?? "",
        reviewerApproved: reviewerApprovedForOutcome,
        coverageBlocks: false,
        ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
      });
      publishOutcome = published.outcome;
    }
    // Thread the publish outcome into the note (append, never clobber an existing diagnostic note
    // such as the static-gate's joined validation errors or the health pre-flight's captured
    // InfraError message) — mirrors the mainline's own publishOutcome-into-note threading.
    const combinedNote = [note, publishOutcome].filter((part): part is string => Boolean(part)).join("\n\n") || undefined;
    let terminalOutcome: RunOutcome | undefined;
    if (!skipPersist) {
      terminalOutcome = this.toRunOutcome(input, decision, [], retries, null, errorClass, {
        // Legacy parity: the terminal persists the SAME static value its returned gateSignals carry
        // (ev.static — false for the static-gate invalid AND the health-preflight quirk alike).
        staticOk: ev.static,
        reviewerApproved: reviewerApprovedForOutcome,
        note: combinedNote,
        ...groundingSignals,
        // WS1.6 (full-flow remediation): the SAME conditional-spread discipline as the mainline
        // exit's own rulesRetrieved threading (above, `...(retrievedRuleIds.length ? {...} : {})`) —
        // an empty array (retrieval found nothing, or a future pre-retrieval caller passes the
        // default) omits the override entirely, falling back to toRunOutcome's own `?? []` default;
        // a non-empty array reaches the persisted RunOutcome so the terminal `learning.fold()` call
        // below is no longer a structural no-op for rule-outcome attribution.
        ...(rulesRetrieved.length ? { rulesRetrieved } : {}),
      });
      await this.deps.runHistory.save(terminalOutcome);
      // post-cutover-remediation P3 (unit 4): the SAME shouldDistillLearning guard as the mainline
      // fold site, applied here too for symmetry — this helper serves the static-gate invalid and
      // health-preflight infra-error exits, BOTH of which run BEFORE the FixLoop ever engages (the
      // FixLoop only runs after a real execute() inside the mainline body), so
      // `terminalOutcome.adjudication` is ALWAYS undefined on this path today, making this guard a
      // structural no-op (shouldDistillLearning(cfg.isCode, "invalid", undefined) === true whenever
      // cfg.isCode is false, or whenever isCode+invalid — never suppressed by the app_defect clause,
      // since adjudication is never set here). Kept anyway so a FUTURE reorder that routes an
      // adjudicated outcome through this terminal path can never silently bypass the suppression.
      if (verdict === "invalid" && shouldDistillLearning(cfg.isCode, verdict, terminalOutcome.adjudication?.class)) {
        await this.deps.learning.fold(terminalOutcome);
      }

      // reflector-rewire (design ADR-1): mirrors the mainline site's identical stricter reflect gate
      // — reused verbatim, not re-derived. The `verdict === "invalid"` guard above already excludes
      // "flaky" structurally (TS narrows `verdict` to the literal "invalid" here, so a redundant
      // `verdict !== "flaky"` check would be a compile error, not just dead code) AND excludes
      // infra-error from ever reaching this block (infra-error stays fold-free AND reflect-free,
      // unchanged) — so the errorClass!=="E-INFRA" check below is a structural belt-and-braces guard
      // (defensive parity with the mainline site's identical condition), not a currently-reachable
      // branch on this path today.
      //
      // WS1.2 VERIFIED (full-flow remediation): unlike the mainline site, this terminal does NOT need
      // the additional `errorClass != null && errorClass !== ""` conjunct. `verdict` is narrowed by
      // TypeScript to the literal `"invalid"` (this helper's own signature: `verdict: "invalid" |
      // "infra-error"`, further narrowed by the `verdict === "invalid"` check above), and
      // errorClassFromVerdict's switch (error-class.ts) resolves `case "invalid": return "E-STATIC"`
      // UNCONDITIONALLY — there is no branch, coverage check, or reviewer-correction path that can
      // turn an "invalid" verdict into a null errorClass. `errorClass` here (derived at
      // this.deriveErrorClass(verdict, null, null), above) is therefore ALWAYS the literal string
      // "E-STATIC", never null and never "" — a reachable-null scenario is structurally impossible on
      // this path, so no gate change was needed here; the mainline site is the ONLY one WS1.2 fixes.
      if (
        this.deps.reflector &&
        verdict === "invalid" &&
        shouldDistillLearning(cfg.isCode, verdict, terminalOutcome.adjudication?.class) &&
        terminalOutcome.errorClass !== "E-INFRA" &&
        terminalOutcome.errorClass !== "E-FLAKY"
      ) {
        await this.deps.reflector.reflect(this.toReflectionInput(terminalOutcome));
      }
    }
    this.deps.observer?.onStep("done");
    return {
      decision,
      // Determinism fix: return the EXACT persisted outcome (see RunQaResult.outcome's own doc).
      ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
      // FIX 2 (judgment-day D.7 batch 2): when skipPersist is true (the context-mode invalid path),
      // nothing was genuinely persisted — the legacy's own comparator counterpart
      // (LegacyPipelineAdapter's synthesizeContextOutcome(), the SAME placeholder the context CLEAN
      // pass compares against) hardcodes errorClass:null, since there is no real taxonomy-derived
      // classification worth reporting for a run that was never saved. Reporting the structurally
      // "correct" E-STATIC here would surface an artifact of this composition's own internal
      // deriveErrorClass() call (still computed above for internal consistency) rather than the
      // legacy's true "nothing was persisted" signal.
      errorClass: skipPersist ? null : errorClass,
      gateSignals: {
        // Same placeholder-fidelity reasoning as errorClass above: static/reviewerApproved/retries
        // all reflect "nothing was genuinely persisted" when skipPersist is true.
        static: skipPersist ? false : ev.static,
        coverageRatio: null,
        valueScore: null,
        ...(!skipPersist && reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries: skipPersist ? 0 : retries,
        preExecAmbiguityCatches: skipPersist ? 0 : groundingSignals.preExecAmbiguityCatches,
        deterministicSelectorBlocks: skipPersist ? 0 : groundingSignals.deterministicSelectorBlocks,
        catalogGateInWindow: skipPersist ? 0 : groundingSignals.catalogGateInWindow,
        catalogGateAdvisory: skipPersist ? 0 : groundingSignals.catalogGateAdvisory,
        catalogGateFailClosed: skipPersist ? 0 : groundingSignals.catalogGateFailClosed,
      },
      cases: [],
      // WS1.6 (full-flow remediation): SUPERSEDES the prior "always [], matches legacy" comment here
      // — legacy's own persistOutcome(invalid/infra, ...) calls (src/pipeline.ts:2315/2334) never
      // threaded retrievedRuleIds, but that was legacy's gap, not a deliberate contract this
      // rewrite must reproduce: an invalid/infra-error terminal in which retrieved rules failed to
      // prevent the verdict is legitimate fold evidence the prior [] silently discarded (the
      // terminal `learning.fold()` call above was a structural no-op whenever rulesRetrieved.length
      // was 0). Mirrors the mainline exit's own isContextCleanPass-gated rulesRetrieved (above): []
      // only when skipPersist is true (nothing was genuinely persisted) or when this helper's caller
      // passed no ids (a pre-retrieval exit, which never reaches this helper today — see
      // retrievedRuleIds's own derivation ordering).
      rulesRetrieved: skipPersist ? [] : rulesRetrieved,
      ...(!skipPersist && combinedNote !== undefined ? { note: combinedNote } : {}),
    };
  }
}

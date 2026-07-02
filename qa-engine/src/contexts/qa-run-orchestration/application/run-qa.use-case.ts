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
  ObserverPort,
  CommitIntent,
  PreExecGroundingPort,
} from "./ports/index.ts";
import { decide, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import { checkSpecSelectors } from "../domain/helpers/selector-check.ts";
import { resolveErrorClass } from "../domain/helpers/error-class.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import { checkPreExecGrounding, checkPersistingAmbiguity } from "../domain/pre-exec-grounding.service.ts";

// FIX B (judgment-day, HIGH)'s own value: the change-coverage minRatio default (src/qa/
// change-coverage.ts's DEFAULT_COVERAGE_POLICY.minRatio) — needed here too so the FIX 4 errorClass
// derivation (E-COVERAGE-GAP band) uses the SAME threshold the legacy's labelRunOutcome() reads
// (app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio at src/pipeline.ts:1111).
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

// FIX 3 (judgment-day D.7 batch 2): the static-gate (Filter B) repair-round bound, verbatim from
// src/pipeline.ts:804's `const MAX_STATIC_FIX_ROUNDS = 2;` — the SAME constant, not an invented
// policy, gating the static-fix loop this use-case's validate phase now ports.
const MAX_STATIC_FIX_ROUNDS = 2;

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
  // [SWAP] absent -> every onStep() call below is a no-op (backward compatible with every
  // pre-existing composition/test that has not wired an ObserverPort yet — this is exactly why
  // ObserverPort.onStep/onEvent were never called anywhere before this fix: nothing in this
  // use-case ever reached for `this.deps.observer`). When present, onStep(step, detail) fires at
  // each phase boundary this use-case actually crosses, using the SAME step VOCABULARY the legacy
  // runPipeline's own onStep callback emits (src/server/runner.ts's RUN_EVENT_STEPS: "gate" |
  // "classify" | "setup" | "generate" | "validate" | "health" | "execute" | "coverage" | "retry" |
  // "decide" | "done"). Only phases this use-case genuinely executes emit a step — a step the
  // use-case never reaches (e.g. "coverage" on a non-"pass" verdict, or on a non-diff/cross-repo
  // pass — see the guard at the measure phase below) is never fabricated.
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
}

export interface RunQaResult {
  decision: RunDecision;
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
  // W3 F2 (mirrors errorClass/valueScore/reviewerApproved's own doc above): the retrieved rule
  // trigger strings, surfaced HERE so RewrittenOrchestratorAdapter's toOutcome() can mirror the SAME
  // value toRunOutcome() persisted (mainline exit only — see toRunOutcome's own rulesRetrieved doc;
  // every other exit's persisted outcome is [], matching legacy's persistOutcome asymmetry exactly).
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
    // propagated. `retrievedRuleTriggers` feeds BOTH the prompt enrichment (below) and the persisted
    // RunOutcome.rulesRetrieved (toRunOutcome), matching legacy's retrievedRuleIds dual-use exactly
    // (src/pipeline.ts:2038's retrievedRuleIds assignment, later reused at persistOutcome time).
    let retrievedRuleTriggers: string[] = [];
    try {
      retrievedRuleTriggers = await this.deps.learning.retrieve(input.sha);
    } catch (err) {
      console.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", err);
    }

    const baseEnrichment = {
      sha: input.sha.toString(),
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRuleTriggers.length ? { learnedRules: retrievedRuleTriggers } : {}),
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
      await this.deps.runHistory.save(
        this.toRunOutcome(input, skipped.decision, [], 0, null, skipped.errorClass, {
          reviewerApproved: skipped.gateSignals.reviewerApproved,
        }),
      );
      return skipped;
    }

    // FIX 3 (judgment-day D.7 batch 2): retries is hoisted ABOVE the validate phase (the legacy's
    // own module-scope `retries` variable is incremented by BOTH the static-fix loop below AND the
    // FixLoop further down, accumulating into ONE shared counter across both loops — src/
    // pipeline.ts:2265's `retries++` in the static-fix loop, and the FixLoop's own retries++ per
    // verdictual round). Declared here (not reassigned to a fresh 0 at the FixLoop section below).
    let retries = 0;

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
    // the legacy's own `(result?.specs.length ?? 0) > 0` conjunct at src/pipeline.ts:2261) — this
    // composition's GenerationPort carries no reviewCorrections-shaped feedback field (the SAME
    // established port-shape limit the FixLoop's own generation wiring already accepts a few lines
    // below, per fix-loop.aggregate.ts's own header), so the repair regen call is the identical
    // `this.deps.generation.generate([], workspace.specDir)` shape this use-case already uses
    // everywhere else — porting the LOOP CONDITION + BOUND exactly, not a new feedback channel.
    //
    // `lastGenerated` mirrors the legacy's own `result` reassignment across the loop (src/
    // pipeline.ts:2269's `result = await generateOnce(...)`) — the LATEST generation attempt's own
    // `approved` flag is what FIX 1's reviewerApprovedFromGeneration (below) must read, not the
    // stale pre-repair `generated` value.
    this.deps.observer?.onStep("validate");
    let validation = await this.deps.validation.validate(workspace.specDir);
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
      lastGenerated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, baseEnrichment);
      validation = await this.deps.validation.validate(workspace.specDir);
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
      // NOTE on validation.infra (CLAUDE.md invariant scope): this branch is deliberately NOT split
      // on validation.infra here — that verdict-mapping divergence from the legacy (infra:true should
      // map to "infra-error", not "invalid"; src/pipeline.ts:2305) is a KNOWN, DECLARED divergence
      // tracked in parity-allowlist.json ("scenarios.ts:codemode-infra-toolchain" in
      // golden-outcome.test.ts) with its own explicit "not reproducible/fixed at this layer per this
      // task's scope" note — changing the verdict here would silently close that allowlisted gap and
      // break golden-outcome.test.ts's own assertion that the divergence still exists. This fix's
      // scope is strictly the diagnostic note (CLAUDE.md "surface integration errors loudly"), not
      // the verdict-mapping gap — so validation.errors now reaches the note on the SAME "invalid"
      // verdict this branch already returns, leaving the Task E.0/Slice E consumption gap untouched.
      console.error("[qa] static gate failed:", validation.errors);
      // Diagnosability fix: an empty, unapproved generation (generationNote, above) reaching this
      // static-gate failure means the static-gate errors ALONE would hide WHY nothing was
      // generated in the first place — append the agent's own note so both are visible.
      const staticGateNote = [validation.errors.slice(0, 2).join("\n\n") || undefined, generationNote]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") || undefined;
      return await this.terminalResult(
        "invalid",
        cfg,
        input,
        { generating, static: false },
        reviewerApprovedFromGeneration,
        input.mode === "context",
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
    let run = input.mode === "context"
      ? { verdict: "pass" as const, cases: [] as QaCase[], logs: generated.note ?? "" }
      : await this.deps.execution.execute(workspace.specDir, signal);
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
        execute: async () => {
          const r = await this.deps.execution.execute(workspace.specDir, signal);
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
          return { specs: r.specs, approved: r.approved, note: r.note };
        },
      };
      const fixLoopSelectorCheck: FixLoopSelectorCheckPort = {
        check: (specSources, trees) => checkSpecSelectors(specSources, trees),
      };
      const fixLoop = new FixLoop({
        execution: fixLoopExecution,
        generation: fixLoopGeneration,
        selectorCheck: fixLoopSelectorCheck,
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
      });
      run = { verdict: fixLoopResult.run.verdict, cases: fixLoopResult.run.cases, logs: run.logs };
      // FIX 3 (judgment-day D.7 batch 2): ACCUMULATE onto the shared `retries` counter (`+=`), not a
      // reassignment — the legacy's single module-scope `retries` variable is incremented by BOTH
      // the static-fix loop (src/pipeline.ts:2265) and the fix-loop (src/pipeline.ts:2723) onto the
      // SAME running total, never reset between them. A plain `retries = fixLoopResult.retries`
      // would silently DISCARD any repair rounds the static-fix loop already consumed above.
      retries += fixLoopResult.retries;
    }

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
      const signal = await this.deps.objectiveSignal.measure(
        BlastRadius.of(input.sha, []),
        workspace.specDir,
        input.triggerRepo ? undefined : classificationDiff,
      );
      coverageRatio = signal.ratio;
      valueScore = signal.valueScore ?? null;
      // FIX B (judgment-day, HIGH): blocksPublish must respect the policy mode — "unknown"/"pass"
      // never block either side of the mode, and "fail" blocks ONLY in "enforce" (src/qa/
      // change-coverage.ts:179-181's blocksPublish()). Unconditionally blocking on "fail" wrongly
      // held the PR in the default "signal" mode, contradicting CLAUDE.md's keystone contract.
      blocksPublish = cfg.coveragePolicyMode === "enforce" && signal.status === "fail";
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
      for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
        const reviewResult = await this.deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
          ...baseEnrichment,
          ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
        });
        // FIX A (judgment-day, HIGH) + F3 (legacy :1705-1714): parsed:false is a parse miss — NOT an
        // actionable rejection to re-prompt against, but ALSO never a free pass. Fails CLOSED
        // IMMEDIATELY, without burning a regeneration round (matches the legacy exactly — see the
        // header comment above).
        if (reviewResult.parsed === false) {
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
    if (!isContextCleanPass) {
      const mainlineOutcome = this.toRunOutcome(input, decision, run.cases, retries, coverageRatio, errorClass, {
        reviewerApproved: reviewerApprovedForOutcome,
        valueScore: gateValueScore,
        // FIX F1: the publish outcome string (e.g. "pr: <url>", "issue: <url>", "quarantine: ...",
        // "shadow: ...", "noop: ...") reaches the persisted RunOutcome so a run's publish result is
        // diagnosable from the run record alone — never fabricated when publish() was never called
        // (decision.sideEffect === "none").
        ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
        // W3 F2 (legacy parity: src/pipeline.ts:3267's persistOutcome(..., rulesRetrieved:
        // retrievedRuleIds, ...) — the ONLY persistOutcome call site that threads it): the retrieved
        // rule triggers reach the persisted RunOutcome on the mainline exit only.
        ...(retrievedRuleTriggers.length ? { rulesRetrieved: retrievedRuleTriggers } : {}),
        // Plan 7-R B5.3 (leak 3 fix): the pre-exec grounding gate's real, run-level accumulated
        // counters — replaces the hardcoded 0 the persisted RunOutcome carried before this gate
        // existed (mirrors legacy's persistOutcome() reading its own module-scope accumulators,
        // src/pipeline.ts:1134-1140).
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
        // W3 F3: the execution logs ExecutionPort.execute() already returned — reaches the
        // persisted RunOutcome the SAME way cases does (see toRunOutcome's own cases doc).
        logs: run.logs,
      });
      await this.deps.runHistory.save(mainlineOutcome);

      // Phase: fold (LearningPort) — off-path by contract: never gates the verdict, failures are
      // swallowed at the port's own boundary (not this use-case's concern to catch).
      await this.deps.learning.fold(mainlineOutcome);
    }

    this.deps.observer?.onStep("done");
    return {
      decision,
      errorClass,
      // FIX F1: surface the SAME publish outcome on the returned RunQaResult (mirrors the persisted
      // RunOutcome above) — so a caller with no read-back path on RunHistoryPort (e.g.
      // RewrittenOrchestratorAdapter's toOutcome()) can still report what publish() actually did.
      ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
      // W3 F2: mirrors the SAME isContextCleanPass gate the persisted mainlineOutcome above uses —
      // a clean context pass never persists (see isContextCleanPass above), so its returned
      // RunQaResult must not report retrieved rules either (nothing was genuinely persisted).
      rulesRetrieved: isContextCleanPass ? [] : retrievedRuleTriggers,
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
      reviewerApproved?: boolean;
      valueScore?: number | null;
      note?: string;
      rulesRetrieved?: string[];
      preExecAmbiguityCatches?: number;
      deterministicSelectorBlocks?: number;
      catalogGateInWindow?: number;
      catalogGateAdvisory?: number;
      catalogGateFailClosed?: number;
      // W3 F3: the execution logs, same optional-override precedent as note/rulesRetrieved above —
      // only the mainline caller (post-execute) has real logs to thread.
      logs?: string;
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
        static: true,
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
    if (!skipPersist) {
      const outcome = this.toRunOutcome(input, decision, [], retries, null, errorClass, {
        reviewerApproved: reviewerApprovedForOutcome,
        note: combinedNote,
        ...groundingSignals,
      });
      await this.deps.runHistory.save(outcome);
      if (verdict === "invalid") {
        await this.deps.learning.fold(outcome);
      }
    }
    this.deps.observer?.onStep("done");
    return {
      decision,
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
      // W3 F2: legacy parity — neither invalid nor infra-error persistOutcome call threads
      // retrievedRuleIds (src/pipeline.ts:2315/2334's persistOutcome(invalid/infra, ...) calls both
      // omit it), so this terminal's outcome is always [], matching toRunOutcome's own default above.
      rulesRetrieved: [],
      ...(!skipPersist && combinedNote !== undefined ? { note: combinedNote } : {}),
    };
  }
}

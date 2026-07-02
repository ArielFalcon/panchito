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
} from "./ports/index.ts";
import { decide, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import { checkSpecSelectors } from "../domain/helpers/selector-check.ts";
import { resolveErrorClass } from "../domain/helpers/error-class.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";

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
  };
  cases: QaCase[];
  // Diagnostic note for an infra-error-shaped terminal (CLAUDE.md "surface integration errors loudly
  // — never swallow errors into an empty result"): the InfraError/thrown-error message that caused
  // the terminal exit, so a run that dead-ends here is diagnosable from the run record alone instead
  // of requiring live-container instrumentation. Optional — absent on every OTHER terminal (skipped/
  // invalid/pass/fail/flaky) unless a caller explicitly threads one; never fabricated.
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
    let classificationDiff: string | undefined;
    if (input.mode === "diff") {
      const classification = await this.deps.changeAnalysis.classify(input.sha);
      classificationDiff = classification.diff;
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

    // Phase: generate (GenerationPort).
    const generated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff);

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
      // "Dynamic diff" fix: the repair regeneration reuses the SAME classificationDiff, not a
      // dropped/empty value — a repair round must see the same real change context the initial
      // generate() call did.
      lastGenerated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff);
      validation = await this.deps.validation.validate(workspace.specDir);
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
        validation.errors.slice(0, 2).join("\n\n") || undefined,
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
      const healthNote = lastHealthCheckError ?? "DEV health pre-flight failed before execute";
      console.error("[qa] health pre-flight failed before execute:", healthNote);
      return await this.terminalResult("infra-error", cfg, input, { generating, static: false }, reviewerApprovedFromGeneration, false, retries, healthNote);
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
      const fixLoopExecution: FixLoopExecutionPort = {
        execute: async () => {
          const r = await this.deps.execution.execute(workspace.specDir, signal);
          return { verdict: r.verdict, cases: r.cases };
        },
      };
      const fixLoopGeneration: FixLoopGenerationPort = {
        generate: async () => {
          // "Dynamic diff" fix: the FixLoop's own regenerate() call also reuses the SAME
          // classificationDiff — every generation attempt across the whole run sees the same real
          // per-run diff, never a stale/empty static fallback.
          const r = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff);
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
      const reviewResult = await this.deps.review.review(workspace.specDir, run.cases, classificationDiff);
      // FIX A (judgment-day, HIGH): parsed:false is a parse miss — NOT an actionable rejection to
      // re-prompt against, but ALSO never a free pass. The legacy fails CLOSED on a parse-miss/
      // reviewer outage: green-but-unreviewed work must never publish (src/integrations/
      // opencode-client.ts:1704-1710: "A parse miss is NOT an actionable rejection... Treat it like
      // a reviewer error (fail closed)."; src/pipeline.ts:1690-1694: "A reviewer outage must never
      // silently degrade every run to generator-self-approval"). Treating parsed:false as approved
      // would fail OPEN — the opposite of the invariant.
      reviewerApproved = reviewResult.parsed === false ? false : reviewResult.approved;
      // FIX 1 (judgment-day D.7 batch 2): a GENUINE review call's own verdict OVERWRITES generation's
      // self-approval default above — the independent reviewer's judgment always wins when it
      // actually ran, matching the legacy's real (non-no-op) reviewGenerated() path, which returns
      // `{...r, approved: reviewResult.approved}`-shaped results that DO feed back into `result`.
      reviewerApprovedForOutcome = reviewerApproved;
    }

    // Phase: decide (RunDecisionService).
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

    // Phase: publish (PublicationPort) — only the "pr" side effect actually calls the publish port;
    // "issue"/"shadow-log"/"quarantine"/"none" are the CALLER's (composition root's) publication
    // concern once real bridge adapters (Task E.0) are wired — this use-case's own scope is the
    // decision, not the 11 bridges' dispatch logic.
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
    if (decision.sideEffect === "pr") {
      await this.deps.publication.publish({
        verdict: run.verdict,
        cases: run.cases,
        logs: run.logs,
        reviewerApproved,
        coverageBlocks: blocksPublish,
      });
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
      });
      await this.deps.runHistory.save(mainlineOutcome);

      // Phase: fold (LearningPort) — off-path by contract: never gates the verdict, failures are
      // swallowed at the port's own boundary (not this use-case's concern to catch).
      await this.deps.learning.fold(mainlineOutcome);
    }

    return {
      decision,
      errorClass,
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
        preExecAmbiguityCatches: 0,
        deterministicSelectorBlocks: 0,
      },
      cases: run.cases,
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
    extra?: { reviewerApproved?: boolean; valueScore?: number | null; note?: string },
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
        preExecAmbiguityCatches: 0,
        deterministicSelectorBlocks: 0,
      },
      rulesRetrieved: [],
      ...(extra?.note !== undefined ? { note: extra.note } : {}),
      at: new Date().toISOString(),
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
      },
      cases: [],
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
    return {
      decision: RunDecision.of("infra-error", "none"),
      // FIX 4 (judgment-day D.7): the entry-gate infra-error never persists (matches the legacy,
      // which throws/returns before persistOutcome is reachable), but errorClass is still derived
      // consistently via the SAME taxonomy for internal consistency of this returned RunQaResult.
      errorClass: this.deriveErrorClass("infra-error", null, null),
      gateSignals: { static: false, coverageRatio: null, valueScore: null, retries: 0, preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0 },
      cases: [],
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
    if (!skipPersist) {
      const outcome = this.toRunOutcome(input, decision, [], retries, null, errorClass, {
        reviewerApproved: reviewerApprovedForOutcome,
        note,
      });
      await this.deps.runHistory.save(outcome);
      if (verdict === "invalid") {
        await this.deps.learning.fold(outcome);
      }
    }
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
        preExecAmbiguityCatches: 0,
        deterministicSelectorBlocks: 0,
      },
      cases: [],
      ...(!skipPersist && note !== undefined ? { note } : {}),
    };
  }
}

// qa-engine/src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts
// The FixLoop aggregate (design §5.3(1); Task D.4 — THE HARDEST + RISKIEST BUILD in the plan).
// PORTS the legacy fix-loop block VERBATIM into a guarded structure — NOT a rewrite. The real
// anchors (re-derived by grepping src/pipeline.ts at HEAD; the plan's cited ~2416-2760 was STALE)
// are src/pipeline.ts:2527-2886:
//   per retry — Lever-2 selector check (checkSpecSelectors, per-case, never fused) → pure
//   adjudicate() (the single decision point) → break-issue (RUNNER_INFRA/DEV_INFRA → infra-error,
//   else realBugDetected) / break-needs-human → regen via GenerationPort (review:skip) → Lever-2
//   absentKeys short-circuit (skip re-execute, loop again) → e2e re-validate + devHealthy +
//   execute under a per-attempt namespace (`retryNs`) → filtered-retry (scope to failing spec
//   files only when change-coverage will NOT measure this run) → merge filtered results →
//   coverageNs tracks the winning run → bestRunSoFar regression guard (fewest failures) after the
//   loop.
//
// Sub-decisions ported, in the legacy's own order:
//   1. Loop condition: retry < MAX_RETRIES && run.verdict === "fail" && generating (:2566).
//   2. Lever-2 selector check per failed case vs failure-point trees (:2573-2605).
//   3. Pure adjudicate(evidence) — the single decision point (:2655-2683, re-ported at
//      ./adjudicate.service.ts, see that file's header for why it is NOT qa-engine's OTHER
//      adjudicate.service.ts under test-execution).
//   4. break-issue routing: RUNNER_INFRA/DEV_INFRA → infra-error; else → realBugDetected=true,
//      verdict stays fail (:2687-2699). break-needs-human exits the loop via the SAME guard
//      (:2707) without setting realBugDetected — the Issue is labeled from the adjudicator verdict
//      by the CALLER (the Run.aggregate/RunQaUseCase composition, Task D.5), not this aggregate.
//   5. Regeneration via GenerationPort with {review:"skip"} semantics (:2724-2732).
//   6. Lever-2 absentKeys short-circuit: regenerate WITHOUT re-executing, loop straight to the next
//      round (:2755-2758).
//   7. e2e re-validate + devHealthy + execute under a per-attempt namespace `retryNs` (:2773-2793).
//   8. Filtered-retry: scope the re-run to failing spec files only when change-coverage will NOT
//      measure this run (:2795-2829).
//   9. Merge filtered results: carry forward every non-re-run case, splice in the re-run's results
//      (:2840-2855).
//   10. coverageNs tracks the winning run's namespace (:2859).
//   11. bestRunSoFar regression guard — keep the fewest-failures EXECUTED run, restored AFTER the
//       loop unless realBugDetected fired or the loop ended on infra-error (:2863-2886).
//
// FIX F4 (contract, judgment-day): CycleBudget/WallClockBudget (Task D.2's VOs) do NOT guard
// anything INSIDE this aggregate's run() — verified against the legacy: the MAX_CYCLES/cycleCount +
// wallClockBudget check lives ENTIRELY inside generateOnce (src/pipeline.ts:1558-1578), which
// generateAndReview wraps, i.e. the GENERATION concern, not the fix-loop block (:2527-2886) this
// aggregate ports. FixLoopInput requires these VOs and this aggregate forwards them, unread, into
// EVERY FixLoopGenerationPort.generate() call (see FixLoopGenerateInput.cycleBudget/wallClockBudget)
// — the SAME call boundary the legacy checks at. A composed generation adapter (Task D.5's
// composition root, wrapping the real generateAndReview) is where the actual tick()/exhausted()
// enforcement happens, exactly mirroring where the legacy enforces it. This aggregate stays a pure
// decision object: it neither ticks nor inspects these VOs, only threads them to their rightful
// consumer.
//
// NO POLICY REWRITE — this is the riskiest port in the plan. fix-loop-characterization.test.ts
// validates it reproduces the EXACT retry counts + final verdicts of the fail-issue (retries:1) and
// invalid-issue (retries:2) goldens.

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { CycleBudget } from "./cycle-budget.ts";
import type { WallClockBudget } from "./wall-clock-budget.ts";
import { adjudicate, type AdjudicatorEvidence, type AdjudicatorVerdict, ADJ_CLASS, ADJ_ACTION } from "./adjudicate.service.ts";
import { decideProgress, classifyFailure, bestRound, isLikelyRealBug, type RoundResult } from "./helpers/progress-gate.ts";
import { checkSpecSelectors, type SpecSelectorFindings } from "./helpers/selector-check.ts";

// ── Injected collaborator ports (this aggregate is standalone — driven by stubs until Task D.5
// composes real adapters). Deliberately NARROWER than the shared ports barrel's GenerationPort/
// ExecutionPort: the fix-loop's regen call needs fixCases/selectorContradictions/domSnapshot input
// the barrel's GenerationPort does not carry, and the filtered-retry optimization needs a
// specFiles-scoped execute the barrel's ExecutionPort does not expose either. Reconciling these
// shapes with the shared barrel (or widening it) is Task D.5's composition-root concern — this
// aggregate declares the richer local contract it actually needs, kept intentionally separate so
// this task stays self-contained and does not unilaterally widen a barrel other in-flight tasks
// depend on. ──────────────────────────────────────────────────────────────────────────────────────

export interface FixLoopRun {
  verdict: RunVerdict;
  cases: QaCase[];
}

export interface FixLoopGenerateInput {
  fixCases: QaCase[];
  selectorContradictions?: string[];
  domSnapshot?: string;
  // FIX F4 (contract, judgment-day): the legacy's budget check (MAX_CYCLES/cycleCount,
  // wallClockBudget) lives ENTIRELY inside generateOnce (src/pipeline.ts:1558-1578), which
  // generateAndReview wraps — the GENERATION concern, not the fix-loop block (:2527-2886) itself.
  // These immutable VOs are threaded to the SAME call boundary the legacy checks at, so a composed
  // generation adapter (D.5's composition root) enforces the SAME guard the legacy does. The
  // fix-loop aggregate itself never ticks/inspects these — it only forwards them.
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
}
export interface FixLoopGenerateResult {
  specs: string[];
  approved: boolean;
  note?: string;
  // FIX F1 (judgment-day): browser NAVIGATIONS the agent made PRODUCING this regen result (mirrors
  // AgentResult.reexploreNavigations, src/types.ts:73). Read at the START of the NEXT round's gate
  // evaluation (src/pipeline.ts:2626) — the round-N-1 regen's nav count feeds round N's
  // RoundResult.reexploreNavigations, letting decideProgress downgrade a heavy re-exploration round
  // to no-progress even when the failing-name set changed (Signal B). Absent ⇒ treated as 0 (no
  // gating), matching the legacy's `result?.reexploreNavigations ?? 0`.
  reexploreNavigations?: number;
  // FIX F3 (confirmed, structural): the CURRENT round's generated spec SOURCE text (file I/O reading
  // the specs named above), mirrors src/pipeline.ts:2590-2596 — the legacy re-reads the just-written
  // spec files fresh EVERY round so Lever-2 checks the LATEST agent output, not a stale snapshot.
  // File I/O stays outside the domain (the composed generation adapter reads the files; this
  // aggregate never calls readFileSync): a composed adapter populates this from the CURRENT
  // generate() call's own output. Absent/empty ⇒ Lever-2 finds nothing to check against for this
  // round (matches the legacy's `haveTrees && result != null` guard degrading to `[]`).
  specSources?: string[];
}
export interface FixLoopGenerationPort {
  generate(input: FixLoopGenerateInput): Promise<FixLoopGenerateResult>;
}

export interface FixLoopExecuteInput {
  namespace: string;
  specFiles?: string[];
}
export interface FixLoopExecutionPort {
  execute(input: FixLoopExecuteInput): Promise<FixLoopRun>;
}

export interface FixLoopSelectorCheckPort {
  check(specSources: string[], trees: string[][]): SpecSelectorFindings;
}

export interface FixLoopDeps {
  execution: FixLoopExecutionPort;
  generation: FixLoopGenerationPort;
  selectorCheck: FixLoopSelectorCheckPort;
  // Optional: revalidate() mirrors the legacy's re-validate step before a non-filtered retry-execute
  // (:2775). Absent = validation always passes (matches a stub-driven unit test's default; the
  // characterization test supplies one explicitly for the e2e path).
  revalidate?: (specDir: string) => Promise<{ ok: boolean; errors: string[] }>;
}

// ── Loop input ─────────────────────────────────────────────────────────────────────────────────

export interface FixLoopInput {
  initialRun: FixLoopRun;
  isCode: boolean;
  generating: boolean;
  mode: RunMode;
  objectiveSource: string[];
  maxRetries: number;
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
  devHealthy: () => Promise<boolean>;
  namespace: string;
  // FIX F3 (confirmed, structural): seeds ROUND 0's Lever-2 check with the INITIAL (pre-loop)
  // generation's spec source text — mirrors src/pipeline.ts's `result` local being ALREADY populated
  // by the pre-loop generation before the fix-loop's first iteration ever reads it (:2590-2596, where
  // `result` at retry===0 is the initial generation's AgentResult, not null). Every round AFTER round
  // 0 instead uses the CURRENT regen call's OWN FixLoopGenerateResult.specSources (fresh every round,
  // never this static seed) — see FixLoopGenerateResult.specSources. Absent/empty ⇒ round 0's Lever-2
  // check finds nothing to verify against (matches the legacy's `result != null` guard degrading to
  // `[]` when no pre-loop generation ran).
  initialSpecSources?: string[];
  // Change-coverage keystone guard (:2559-2564): true only when this run WILL be measured for
  // change-coverage — filtering a retry to a subset of spec files would then silently undercount
  // coverage (the passing specs' lines would look uncovered). Defaults to false (never filter is the
  // SAFE default for a unit test; the characterization test threads the real value).
  coverageWillMeasure?: boolean;
  // Best-effort: a snapshot string for the regen prompt (buildFailureDom's output). Threaded into
  // GenerationPort verbatim; absent when no failed case carries a failureDom.
  failureDomSnapshot?: string;
  specDir?: string;
}

export interface FixLoopResult {
  run: FixLoopRun;
  retries: number;
  realBugDetected: boolean;
  // The last adjudicator verdict — threaded into IssueContext for labeling by the CALLER
  // (:2539/2683/2702-2703). undefined when the loop never ran (verdict!=='fail', generating=false,
  // or maxRetries=0).
  lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
  coverageNamespace: string;
}

const failCount = (r: FixLoopRun): number => r.cases.filter((c) => c.status === "fail").length;

// FIX F3 (confirmed, structural): verbatim port of src/pipeline.ts:3313-3316's buildFailureDomLines —
// splits a case's captured failure-point a11y tree into non-empty lines. Pure, dependency-free; used
// to re-derive failedTrees PER ROUND from the CURRENT run's failing cases (never a loop-invariant
// static snapshot).
function buildFailureDomLines(failureDom: string | undefined): string[] {
  if (!failureDom) return [];
  return failureDom.split("\n").filter((l) => l.trim());
}

export class FixLoop {
  constructor(private readonly deps: FixLoopDeps) {}

  async run(input: FixLoopInput): Promise<FixLoopResult> {
    let run = input.initialRun;
    let retries = 0;
    let prevRound: RoundResult | null = null;
    // Regression guard (W1): track the best EXECUTED run (fewest failures), ported verbatim
    // (:2532-2533).
    let bestRunSoFar: FixLoopRun = run;
    let realBugDetected = false;
    let adjVerdict: AdjudicatorVerdict | undefined;
    let coverageNs = input.namespace;
    // FIX F1 + FIX F3: the PRIOR round's regen result — read at the START of the NEXT round's gate
    // evaluation (src/pipeline.ts:2626's reexploreNavigations, :2590-2596's specSources). Seeded with
    // the INITIAL (pre-loop) generation's spec sources so ROUND 0 mirrors the legacy's `result`
    // local already being populated before the fix-loop's first iteration (undefined
    // reexploreNavigations on round 0 is correct — prevRound===null short-circuits the gate before it
    // is ever read).
    let lastRegenResult: FixLoopGenerateResult | undefined = input.initialSpecSources?.length
      ? { specs: [], approved: true, specSources: input.initialSpecSources }
      : undefined;

    const maxRetries = input.maxRetries;

    // Sub-decision 1: the loop condition (:2566) — retry < MAX_RETRIES && verdict==='fail' && generating.
    for (let retry = 0; retry < maxRetries && run.verdict === "fail" && input.generating; retry++) {
      const failed = run.cases.filter((c) => c.status === "fail");

      // Sub-decision 2: Lever-2 selector check per failed case vs its OWN failure-point tree
      // (:2573-2605) — per-case, never fused (a node present on page A must never count as absent
      // against page B).
      //
      // FIX F3 (confirmed, structural): BOTH failedTrees and specSources are re-derived HERE, fresh,
      // every iteration — never a loop-invariant static snapshot. failedTrees comes from the CURRENT
      // round's `failed` cases' OWN failureDom (mirrors src/pipeline.ts:2580-2582's
      // buildFailureDomLines(c.failureDom) exactly); specSources comes from the PRIOR round's regen
      // result (mirrors :2590-2596's `result.specs`/`result` lifecycle — round 0 reads the seeded
      // initial-generation sources via lastRegenResult's pre-loop seed, every later round reads the
      // immediately-prior regen's own FixLoopGenerateResult.specSources).
      const failedTrees = failed
        .map((c) => buildFailureDomLines(c.failureDom))
        .filter((t) => t.length > 0);
      const haveTrees = !input.isCode && failedTrees.length > 0;
      const specSources = haveTrees ? (lastRegenResult?.specSources ?? []) : [];
      const lever2 = this.deps.selectorCheck.check(specSources, failedTrees);
      const selectorContradictions = lever2.contradictions;
      const absentKeys = lever2.absentKeys;
      const anyVerifiedPresent = lever2.anyVerifiedPresent;
      const anyNonExtractableLocator = lever2.anyNonExtractable;
      const anyUnverifiableSelector = lever2.anyUnverifiable;

      const lever2Flips =
        prevRound && prevRound.absentSelectors.size > 0
          ? [...prevRound.absentSelectors].filter((k) => !absentKeys.has(k)).length
          : 0;

      const curRound: RoundResult = {
        failingNames: new Set(failed.map((c) => c.name)),
        failingCount: failed.length,
        absentSelectors: absentKeys,
        lever2Flips,
        // FIX F1: mirrors src/pipeline.ts:2626 exactly — the PRIOR round's regen result's
        // reexploreNavigations count, read at THIS round's gate evaluation. `lastRegenResult` is
        // undefined on round 0 (no regen has happened yet), matching the legacy's `result` local
        // being unset before the loop's first regeneration.
        reexploreNavigations: lastRegenResult?.reexploreNavigations ?? 0,
      };
      const gate = decideProgress(prevRound, curRound);

      // allUnique (:2649-2654) — every checked selector present+unique AND no non-extractable/
      // unverifiable locator anywhere. Ported verbatim.
      const allUnique =
        anyVerifiedPresent &&
        absentKeys.size === 0 &&
        !anyNonExtractableLocator &&
        !anyUnverifiableSelector &&
        !selectorContradictions.some((c) => c.includes("MULTIPLE"));

      // Sub-decision 3: the SINGLE pure decision point (:2655-2683). Fresh devHealthy() call at THIS
      // decision-point snapshot (Rule 2 — dev_infra class); a separate fresh call happens again
      // before the retry-execute below — never shared/memoized (:2660-2662).
      const devHealthyNow = input.isCode ? true : await input.devHealthy();
      const evidence: AdjudicatorEvidence = {
        isCode: input.isCode,
        allUnique,
        failureDetails: failed.map((c) => c.detail ?? ""),
        failureClasses: failed.map((c) => classifyFailure(c.detail ?? "")),
        absentKeysCount: absentKeys.size,
        gateSpend: gate.spend,
        gateReason: gate.reason,
        devHealthy: devHealthyNow,
        mode: input.mode,
        objectiveSource: input.objectiveSource,
        failingFiles: failed.map((c) => c.file),
        httpStatuses: failed.map((c) => c.httpStatus),
        runtimeErrorsByCase: failed.map((c) => c.runtimeErrors ?? []),
      };
      const verdict = adjudicate(evidence);
      adjVerdict = verdict;

      // Sub-decision 4: break-issue / break-needs-human routing (:2687-2707).
      switch (verdict.action) {
        case ADJ_ACTION.BREAK_ISSUE:
          if (verdict.class === ADJ_CLASS.RUNNER_INFRA || verdict.class === ADJ_CLASS.DEV_INFRA) {
            // FIX F2: legacy resultOf() (src/pipeline.ts:3279-3281, called at :2694) ALWAYS returns
            // cases:[] — an infra-error is a discarded run, never a fix-candidate carrier.
            run = { verdict: "infra-error", cases: [] };
          } else {
            realBugDetected = true;
          }
          break;
        case ADJ_ACTION.BREAK_NEEDS_HUMAN:
          // Exits via the guard below; adjVerdict is already set — the caller labels the Issue.
          break;
        case ADJ_ACTION.CONTINUE:
          break;
      }
      if (verdict.action !== ADJ_ACTION.CONTINUE) break; // exit on any break-* action (:2707)

      prevRound = curRound;

      // Sub-decision 5: regeneration via GenerationPort with review:skip semantics (:2711-2732).
      // FIX F4: thread cycleBudget/wallClockBudget to the SAME call boundary the legacy checks them
      // at (generateOnce, inside generateAndReview) — see FixLoopGenerateInput's field comments.
      const result = await this.deps.generation.generate({
        fixCases: failed,
        ...(selectorContradictions.length > 0 ? { selectorContradictions } : {}),
        ...(input.failureDomSnapshot ? { domSnapshot: input.failureDomSnapshot } : {}),
        cycleBudget: input.cycleBudget,
        wallClockBudget: input.wallClockBudget,
      });
      // FIX F1: record THIS round's regen result so the NEXT round's gate evaluation can read its
      // reexploreNavigations (mirrors the legacy's `result` local surviving into the next iteration).
      lastRegenResult = result;

      if (result.specs.length === 0) {
        // Retry agent produced no fixes; keep the original verdict (:2744-2747).
        break;
      }
      retries++;

      // Sub-decision 6: Lever-2 absentKeys short-circuit — regenerate WITHOUT re-executing, loop
      // straight to the next round (:2749-2758). Bounded by the same for-header cap + gate.
      if (!input.isCode && absentKeys.size > 0) {
        continue;
      }

      if (input.isCode) {
        // Code mode: re-run the repo's own test suite (this aggregate's scope is the e2e retry path
        // per the characterization goldens; code-mode compile-gate re-validation is threaded through
        // deps.revalidate the same way e2e's is below — the execution port itself owns the
        // re-compile+re-run sequencing for code mode, matching the design's single-execute-per-round
        // contract).
        const codeRun = await this.deps.execution.execute({ namespace: input.namespace });
        run = codeRun;
      } else {
        // Sub-decision 7: e2e re-validate + devHealthy + execute under a per-attempt namespace
        // `retryNs` (:2772-2793). A fresh namespace per retry avoids a retry colliding with its OWN
        // prior attempt's test data on apps with no delete affordance.
        if (this.deps.revalidate) {
          const reValidation = await this.deps.revalidate(input.specDir ?? "");
          if (!reValidation.ok) break; // retry validation failed; keep original verdict (:2776-2779)
        }
        if (!(await input.devHealthy())) break; // DEV unhealthy before retry execution (:2780-2783)

        const retryNs = `${input.namespace}-r${retry + 1}`;

        // Sub-decision 8: filtered-retry — scope the re-run to failing spec files ONLY when
        // change-coverage will NOT measure this run (:2795-2829).
        const failedSpecFiles = [
          ...new Set(run.cases.filter((c) => c.status === "fail" && c.file).map((c) => c.file as string)),
        ];
        const allFailedHaveFile = run.cases.filter((c) => c.status === "fail").every((c) => !!c.file);
        const regenSpecBasenames = result.specs.map((s) => s.replace(/.*\//, "").replace(/.*\\/, ""));
        const regenHasOverlap = regenSpecBasenames.some((b) =>
          failedSpecFiles.some((f) => f === b || f.endsWith(`/${b}`) || f.endsWith(`\\${b}`)),
        );
        const regenHasOutsiders = regenSpecBasenames.some(
          (b) => !failedSpecFiles.some((f) => f === b || f.endsWith(`/${b}`) || f.endsWith(`\\${b}`)),
        );
        const regenStayedInFailedSet = !(regenHasOverlap && regenHasOutsiders);
        const canFilter =
          allFailedHaveFile &&
          failedSpecFiles.length > 0 &&
          regenStayedInFailedSet &&
          !(input.coverageWillMeasure ?? false);

        const retryRun = await this.deps.execution.execute({
          namespace: retryNs,
          ...(canFilter ? { specFiles: failedSpecFiles } : {}),
        });

        if (retryRun.verdict === "fail" && !(await input.devHealthy())) {
          // FIX F2: legacy resultOf() (src/pipeline.ts:3279-3281, called at :2837) ALWAYS returns
          // cases:[] for the mid-retry infra-error — discard the retry's cases, matching the
          // break-issue infra-error assignment above.
          run = { verdict: "infra-error", cases: [] };
          break;
        }

        if (canFilter) {
          // Sub-decision 9: merge — carry forward every prior case from files NOT re-run, splice in
          // the re-run's results for the re-run files (:2840-2855).
          const rerunFileSet = new Set(failedSpecFiles);
          const carriedForward = run.cases.filter((c) => !(c.file && rerunFileSet.has(c.file)));
          const mergedCases = [...carriedForward, ...retryRun.cases];
          const mergedVerdict: RunVerdict = mergedCases.some((c) => c.status === "fail")
            ? "fail"
            : mergedCases.some((c) => c.status === "flaky")
              ? "flaky"
              : "pass";
          run = { verdict: mergedVerdict, cases: mergedCases };
        } else {
          run = retryRun;
        }
        // Sub-decision 10: coverageNs tracks the winning run's namespace (:2859).
        coverageNs = retryNs;
      }

      // Regression guard bookkeeping (W1): keep the best EXECUTED run seen so far (:2863-2871).
      // infra-error is never "better" (no test cases to count as a fix).
      if (run.verdict !== "infra-error") {
        bestRunSoFar = bestRound([
          { failingCount: failCount(bestRunSoFar), run: bestRunSoFar },
          { failingCount: failCount(run), run },
        ])!.run;
      }
    }

    // Sub-decision 11: bestRunSoFar regression guard, restored AFTER the loop (:2874-2880) — skipped
    // when the real-bug branch fired (the current fail run must reach the Issue) or when the loop
    // ended on infra-error (that verdict must stand).
    if (!realBugDetected && run.verdict !== "infra-error" && failCount(bestRunSoFar) < failCount(run)) {
      run = bestRunSoFar;
    }

    return {
      run,
      retries,
      realBugDetected,
      lastAdjudicatorVerdict: adjVerdict,
      coverageNamespace: coverageNs,
    };
  }
}

// Re-export isLikelyRealBug for callers that need the raw predicate outside the adjudicator (mirrors
// the legacy's own re-use pattern — adjudicate.service.ts already calls it internally at Rule 3).
export { isLikelyRealBug };

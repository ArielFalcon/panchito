// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.ts
// Bridge: ObjectiveSignalPort -> the REAL keystone collaborators. THIN — no new coverage-ratio
// logic. Composes CoverageCollectorPort.collect (raw covered lines), the assembler (diff + raw
// CoverageReport -> ChangeCoverage read-model), DecideCoverageService.decide (the keystone gate —
// VERBATIM, unknown NEVER blocks) and ValueOraclePort.measure (the mutation-testing /
// fault-injection valueScore, the value-oracle keystone companion).
//
// The assembler seam is `(diff, report) => ChangeCoverage` (assemble-change-coverage.ts's own
// exported shape) rather than `(report, br)` — br carries no diff (BlastRadius.changedFiles is
// often empty at the call site; see run-qa.use-case.ts's `BlastRadius.of(input.sha, [])`), while the
// RUN's real diff is exactly what parseDiffHunks needs. Still OPTIONAL: when absent (or when the
// caller has no diff for this run — every non-"diff" mode), decide() correctly receives null ->
// "unknown" -> NEVER blocks (the keystone invariant's own architecturally-safe default).
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ObjectiveSignalPort } from "../../application/ports/index.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, CoverageReport, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";
import { parseDiffHunks } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  oracle: ValueOraclePort;
}

export interface ObjectiveSignalPortStaticContext {
  policy: CoveragePolicy;
  repoDir: string;
  // Optional: turns the raw CoverageReport + the run's diff into the ChangeCoverage read-model
  // decide() consumes. Absent -> the keystone's OWN safe default (unknown, never blocks) — see the
  // header note above. Matches assemble-change-coverage.ts's exported `assembleChangeCoverage` shape.
  assembleChangeCoverage?: (diff: string, report: CoverageReport) => ChangeCoverage;
  baselineCases?: string[];
  // NAMESPACE FIX (see the measure() comment below): the SAME per-run test-data namespace
  // ExecutionPortAdapter uses (composition-root.ts's `cfg.branch`), so this collector reads coverage
  // dumps from the directory execution actually wrote to. Optional + falls back to `br.sha.toString()`
  // (the PRE-EXISTING behavior) so every caller built before this field existed keeps compiling and
  // behaving identically — only a caller that supplies the real branch/namespace gets the fix.
  namespace?: string;
}

export class ObjectiveSignalPortAdapter implements ObjectiveSignalPort {
  constructor(
    private readonly deps: ObjectiveSignalPortCollaborators,
    private readonly ctx: ObjectiveSignalPortStaticContext,
  ) {}

  async measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[]): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null }> {
    // NAMESPACE FIX: the run's coverage dumps (V8 browser dumps AND the Playwright PW_NAMESPACE env
    // that names their directory — config/e2e/fixtures.ts, `.qa/coverage/<namespace>/`) are written
    // under the SAME namespace ExecutionPortAdapter passes to the execution strategies — which is
    // `cfg.branch` (composition-root.ts wireBridges(): `namespace: cfg.branch` on both Generation and
    // Execution). `br.sha.toString()` is a DIFFERENT string (the bare commit sha, not the caller's
    // testDataNamespace(...)-shaped branch) — collecting under it would look in a directory execution
    // never wrote to, silently degrading every run to "unknown" (never a false signal, but never a
    // real one either). Use this.ctx.repoDir's sibling namespace context instead: the adapter's own
    // static ctx carries no namespace field, so the caller (composition-root.ts) must supply the SAME
    // cfg.branch used for execution — see ObjectiveSignalPortStaticContext.namespace below.
    const namespace = this.ctx.namespace ?? br.sha.toString();
    // CHANGED-FILES THREADING: derive the run's real changed files from the diff (reusing the
    // already-ported parseDiffHunks — no new domain logic) and pass them PER-CALL to the collector.
    // This is what lets V8BrowserCoverageAdapter/JacocoCoverageAdapter's URL/package->repo-file
    // resolution work in production, where rewritten-engine-factory.ts constructs the collector with
    // a static `changedFiles: []` placeholder (no per-run diff exists yet at composition time — the
    // SAME documented limitation as `diff: ""` for Generation/Review). Absent diff -> undefined ->
    // the collector falls back to its own constructor value (backward compatible).
    const changedFiles = diff ? [...parseDiffHunks(diff).keys()] : undefined;
    // COLLECTION SHORT-CIRCUIT (judgment-day): the report has exactly one consumer — the assembler.
    // When no assembly will happen (no assembler wired, or the diff was starved: non-diff modes and
    // cross-repo runs), skip the collector's real IO entirely, matching the legacy where collection
    // lives INSIDE the `!triggerService`-gated block (src/pipeline.ts:2912) and never runs for a
    // run that cannot be measured. cc stays null -> decide() -> "unknown"; the oracle is unaffected.
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    const cc: ChangeCoverage | null = willAssemble
      ? this.ctx.assembleChangeCoverage!(diff!, await this.deps.collector.collect(specDir, namespace, changedFiles))
      : null;

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;

    // W4 fix (F2, audit-verified cutover blocker — "the dead value oracle"): the PER-CALL
    // baselineCases (the run's own passing case names, threaded from RunQaUseCase's post-execute
    // `run.cases` — see the port barrel's own measure() header) takes PRECEDENCE over the static
    // ctx.baselineCases fallback. The composition root's own ctx.baselineCases is a composition-time
    // placeholder (rewritten-engine-factory.ts's `baselineCases: []`, ALWAYS empty — no per-run case
    // list exists yet when CompositionConfig is built), so without this per-call arg the oracle
    // received [] on EVERY run and runFaultInjectionOracle returned valueScore:null forever
    // (fault-injection-oracle.adapter.ts's own `baselineCases && baselineCases.length` guard).
    // Absent (a caller/stub that predates this param) -> falls back to ctx.baselineCases, backward
    // compatible with every pre-existing composition/test.
    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases);

    return { status, ratio, valueScore: oracleResult.valueScore };
  }
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.ts
// Bridge: ObjectiveSignalPort -> the REAL keystone collaborators. THIN — no new coverage-ratio
// logic. Composes CoverageCollectorPort.collect (raw covered lines), DecideCoverageService.decide
// (the keystone gate — VERBATIM, unknown NEVER blocks) and ValueOraclePort.measure (the
// mutation-testing / fault-injection valueScore, the value-oracle keystone companion).
//
// PLAN DRIFT (recorded per Task E.0's instruction to report a missing/drifted collaborator): there
// is NO assembly function under objective-signal/ that turns CoverageCollectorPort's raw
// CoverageReport + the diff into the ChangeCoverage read-model DecideCoverageService.decide()
// actually consumes — src/qa/change-coverage.ts's computeChangeCoverage + parseDiffHunks have NOT
// been ported to qa-engine yet (grep-confirmed zero occurrences under objective-signal/). Building
// that line-hunk-mapping logic HERE would be new domain policy smuggled into a "thin bridge" —
// explicitly out of Task E.0's scope. This bridge instead accepts an OPTIONAL injected
// ChangeCoverageAssembler; when absent, decide() correctly receives null -> "unknown" -> NEVER
// blocks (the keystone invariant's own architecturally-safe default, not a workaround). The
// composition root (Task E.1/E.2) or a follow-on declared change is where that port gets built and
// wired in.
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ObjectiveSignalPort } from "../../application/ports/index.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  oracle: ValueOraclePort;
}

export interface ObjectiveSignalPortStaticContext {
  policy: CoveragePolicy;
  repoDir: string;
  // Optional: turns the raw CoverageReport into the ChangeCoverage read-model decide() consumes.
  // Absent -> the keystone's OWN safe default (unknown, never blocks) — see the header note above.
  assembleChangeCoverage?: (report: Awaited<ReturnType<CoverageCollectorPort["collect"]>>, br: BlastRadius) => ChangeCoverage;
  baselineCases?: string[];
}

export class ObjectiveSignalPortAdapter implements ObjectiveSignalPort {
  constructor(
    private readonly deps: ObjectiveSignalPortCollaborators,
    private readonly ctx: ObjectiveSignalPortStaticContext,
  ) {}

  async measure(br: BlastRadius, specDir: string): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null }> {
    const namespace = br.sha.toString();
    const report = await this.deps.collector.collect(specDir, namespace);

    const cc: ChangeCoverage | null = this.ctx.assembleChangeCoverage
      ? this.ctx.assembleChangeCoverage(report, br)
      : null;

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, this.ctx.baselineCases);

    return { status, ratio, valueScore: oracleResult.valueScore };
  }
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/change-analysis-port.adapter.ts
// Bridge: ChangeAnalysisPort -> change-analysis's REAL sibling collaborators. THIN — no new policy.
//
// analyze(sha): delegates to VcsReadPort.blastRadius(sha) verbatim.
// classify(sha): sources message()+diff() from the SAME VcsReadPort, then delegates to the domain
//   classifyCommit(message, diff) function VERBATIM (commit-classification.ts) — Conventional
//   Commits + the diff cross-check that escalates a message/diff contradiction to "generate".
//
// PLAN DRIFT (recorded per Task E.0's own instruction — "if a sibling entry point named in the plan
// does NOT exist at HEAD, STOP and report it"): the plan named "AnalyzeChangeUseCase" as the
// analyze()/classify() collaborator. No such class/use-case exists anywhere under
// change-analysis/ — `analyzeChange(ctx, extractors): Promise<StaticSignal>` is a plain async
// function that assembles STATIC-SIGNAL TELEMETRY (symbols/relations/complexity/patterns), an
// entirely different capability with an entirely different return shape (StaticSignal, not
// BlastRadius) than this port's analyze()/classify(). The REAL collaborators for THIS port are
// VcsReadPort.blastRadius (analyze) and the domain classifyCommit function (classify) — both
// confirmed present and behavior-preserving. Reported in the apply summary; not fabricated here.
import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ChangeAnalysisPort } from "../../application/ports/index.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import { classifyCommit } from "@contexts/change-analysis/domain/commit-classification.ts";

export class ChangeAnalysisPortAdapter implements ChangeAnalysisPort {
  constructor(private readonly vcs: VcsReadPort) {}

  async analyze(sha: Sha): Promise<BlastRadius> {
    return this.vcs.blastRadius(sha);
  }

  async classify(sha: Sha): Promise<{ action: "skip" | "regression" | "generate"; reason: string }> {
    const [message, diff] = await Promise.all([this.vcs.message(sha), this.vcs.diff(sha)]);
    const classification = classifyCommit(message, diff);
    return { action: classification.action, reason: classification.reason };
  }
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/change-analysis-port.adapter.ts
// Bridge: ChangeAnalysisPort -> change-analysis's REAL sibling collaborators. THIN — no new policy.
//
// classify(sha, opts): sources message()+diff() from the SAME VcsReadPort, then delegates to the
//   domain classifyCommit(message, diff) function VERBATIM (commit-classification.ts) — single-
//   commit path (opts.baseSha absent) — or classifyRange (opts.baseSha set, WS7.1) for a
//   baseSha..sha PUSH/PR range. Also returns the SAME fetched diff ("dynamic diff" fix, engram
//   #936) so the caller can thread the run's REAL commit diff into generation, instead of a stale
//   static composition-time value.
//
// intent: W2 fix (F5) — classifyCommit() already computes the FULL CommitIntent (type/breaking/
// message/body/changedFiles) as part of its own CommitClassification return (it `extends
// CommitIntent`) — every field was already being thrown away except action/reason. Surfaced here,
// verbatim, no re-derivation: the SAME classification object already computed above.
//
// WS7.1 (full-flow remediation, multi-commit range restoration): opts.baseSha, when set, switches
// this method to the RANGE path — vcs.diff(sha, {baseSha}) already produces the union diff
// (GitMirrorReadAdapter's own {baseSha,commits} opts, pre-existing), and vcs.otherMessages(sha,
// {baseSha}) (new) enumerates every OTHER commit's message in the range. classifyRange (domain)
// then reduces the whole range to ONE classification: MAX-severity action, head's own intent.
// Absent baseSha -> the single-commit path below, BYTE-IDENTICAL to before this fix (backward
// compatible with every existing caller/test that never passes opts).
//
// WS7.7(a) (full-flow remediation, hygiene): analyze(sha) was DELETED from ChangeAnalysisPort —
// rg-verified zero production callers. It used to delegate to VcsReadPort.blastRadius(sha)
// verbatim; that underlying VcsReadPort method is NOT dead (a separate real caller exists in
// service-topology/application/resolve-cross-repo-impact.use-case.ts), only THIS port's wrapper
// was unreachable. See ports/index.ts's own header for the full rationale.
//
// PLAN DRIFT (recorded per Task E.0's own instruction — "if a sibling entry point named in the plan
// does NOT exist at HEAD, STOP and report it"): the plan named "AnalyzeChangeUseCase" as the
// analyze()/classify() collaborator. No such class/use-case exists anywhere under
// change-analysis/ — `analyzeChange(ctx, extractors): Promise<StaticSignal>` is a plain async
// function that assembles STATIC-SIGNAL TELEMETRY (symbols/relations/complexity/patterns), an
// entirely different capability with an entirely different return shape (StaticSignal, not
// BlastRadius) than this port's classify(). The REAL collaborator for THIS port is the domain
// classifyCommit function (classify) — confirmed present and behavior-preserving. Reported in the
// apply summary; not fabricated here.
import type { Sha } from "@kernel/sha.ts";
import type { ChangeAnalysisPort, CommitIntent } from "../../application/ports/index.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import { classifyRange } from "@contexts/change-analysis/domain/commit-classification.ts";

export class ChangeAnalysisPortAdapter implements ChangeAnalysisPort {
  constructor(private readonly vcs: VcsReadPort) {}

  async classify(sha: Sha, opts?: { baseSha?: Sha }): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent: CommitIntent; contradiction: boolean }> {
    const baseSha = opts?.baseSha;
    // [SWAP] absent VcsReadPort.otherMessages -> [] (single-commit classification, unaffected) —
    // matches this barrel's own backward-compatible collaborator-absence precedent.
    const [message, diff, otherMessages] = await Promise.all([
      this.vcs.message(sha),
      this.vcs.diff(sha, baseSha ? { baseSha } : undefined),
      baseSha && this.vcs.otherMessages ? this.vcs.otherMessages(sha, { baseSha }) : Promise.resolve<string[]>([]),
    ]);
    // WS7.1: byte-identical to the single-commit call when otherMessages is empty (no baseSha, or
    // a degenerate baseSha===sha range) — classifyRange's own doc guarantees this.
    const classification = classifyRange(message, otherMessages, diff);
    // "Dynamic diff" fix (engram #936): surface the SAME diff already fetched above (no second
    // VcsReadPort.diff() call) so the caller (RunQaUseCase) can thread the run's REAL commit diff
    // into generation, instead of the static composition-time value the bridge previously fell
    // back to for every production run.
    //
    // intent (F5): the SAME classification object already carries type/breaking/message/body/
    // changedFiles (CommitClassification extends CommitIntent) — structurally assignable to the
    // port-local CommitIntent shape (ports/index.ts), never re-derived. WS7.1: always the HEAD
    // commit's own (classifyRange's own contract), never an arbitrary range member.
    //
    // contradiction (WS7.4): the SAME classification object's own field, surfaced verbatim —
    // previously the last piece of classifyCommit's output this bridge still discarded.
    return {
      action: classification.action,
      reason: classification.reason,
      diff,
      intent: {
        type: classification.type,
        breaking: classification.breaking,
        message: classification.message,
        body: classification.body,
        changedFiles: classification.changedFiles,
      },
      contradiction: classification.contradiction,
    };
  }
}

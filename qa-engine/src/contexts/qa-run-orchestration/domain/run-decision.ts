// qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.ts
// The RunDecision value object (Task D.3): the output of RunDecisionService.decide() — a
// RunVerdict paired with the SideEffect it triggers. In the legacy src/pipeline.ts, every verdict
// branch assigns run.verdict AND, at the same site, calls exactly one publish/openIssue/log
// action (or none) — see report()'s switch (:3342-3360) and the mainline decide `else` chain
// (:3186-3241). This VO makes that pairing explicit and immutable instead of leaving it implicit
// in the order of two separate statements.
//
// SideEffect widens the characterization harness's 4-value union (test/characterization/
// side-effects.ts: "pr" | "issue" | "shadow-log" | "none") with "quarantine" — the flaky path is
// its own decision outcome (report()'s `case "flaky"`, :3356-3359) even though the legacy code
// never calls a *separate* side-effecting dependency for it (no publish, no openIssue — just a
// log line). RunDecisionService.decide() and its parity pin distinguish "flaky → quarantine" from
// "infra-error → none" and "no-op regression pass → none" even though all three are silent at the
// deps-call level; "quarantine" names that specific decision outcome for the aggregate's own
// callers (Task D.5's wiring), it is not a widening of what side-effects.ts's probe observes.

import type { RunVerdict } from "@kernel/run-verdict.ts";

export type SideEffect = "pr" | "issue" | "shadow-log" | "quarantine" | "none";

export class RunDecision {
  private constructor(
    readonly verdict: RunVerdict,
    readonly sideEffect: SideEffect,
  ) {}

  static of(verdict: RunVerdict, sideEffect: SideEffect): RunDecision {
    return Object.freeze(new RunDecision(verdict, sideEffect));
  }
}

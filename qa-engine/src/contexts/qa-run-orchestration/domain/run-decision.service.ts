// qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.service.ts
// PORT (not a rewrite). The six-verdict policy — scattered across ≥6 sites in src/pipeline.ts —
// consolidated into ONE pure, auditable function. Each branch below is copied from its legacy
// site, in the legacy's own precedence order; the parity pin (run-decision-parity.test.ts) pins
// every verdict path against the Slice A/B.2 goldens' EXPECTED_VERDICT/EXPECTED_SIDE_EFFECT
// tables. This is the R1 (false-green) hotspot — characterized first (Slice A) and trusted last.
//
// Legacy sites this ports, verbatim, in order:
//
// 1. report()'s guard + switch (src/pipeline.ts:3337-3360) — shared across EVERY "not pass" call
//    site (the static-gate invalid/infra-error early-returns at :2306-2325, the health-preflight
//    infra-error at :2330-2337, and the mainline decide-chain's first branch at :3186-3190, which
//    all call `report(...)` directly rather than re-implementing the switch):
//      TOP GUARD (:3337-3340): if (onFailure !== "github-issue") → for "flaky" the SAME
//        "quarantined" outcome is set inline and the function returns; for every other verdict
//        (fail/invalid/infra-error) the function returns WITHOUT reporting anything — no Issue,
//        no PR. This is (bug-register Entry 7) — decide() previously ignored onFailure entirely.
//      case "fail"        → issueOrShadow(shadow,...) (report():3344) — an Issue, or a shadow-log
//                            line when shadow is true (issueOrShadow():3371-3374)
//      case "invalid"     → issueOrShadow(shadow,...) (report():3349) — same shadow-fold as "fail"
//      case "infra-error" → log only, "not reported as a bug" (report():3353-3355) — never calls
//                            issueOrShadow, so shadow-invariant
//      case "flaky"       → quarantined, no PR, no Issue (report():3356-3359) — never calls
//                            issueOrShadow, so shadow-invariant
//
// 2. Two EARLY "skipped" exits that never reach report() at all — both silent (no publish, no
//    openIssue, no report() call whatsoever):
//      classify-skip (pipeline.ts:1263-1267) — a commit whose classifyCommit() action is "skip"
//      agent no-op   (pipeline.ts:2226-2234) — the agent approved with zero specs to publish
//
// 3. The mainline pass-path chain (pipeline.ts:3186-3241, the "TODAY'S EXACT PATH" branch taken
//    when specTriage is OFF or not applicable — see run-decision-parity.test.ts's G4 note for why
//    the specTriage dual-publish branch is NOT folded into this function). This chain does NOT go
//    through report()'s onFailure guard (that guard is report()-only) — but its two Issue-shaped
//    branches (needsReview-rejection, blocksPublish) each call issueOrShadow(shadow,...) directly
//    (:3197, :3209), so they fold to shadow-log exactly like the green publish path already did
//    (bug-register Entry 8 — decide() previously only folded shadow for the green-pr case):
//      if (verdict !== "pass")                     → delegate to report()'s guard + switch (branch 1)
//      else if (!generating)                        → none (regression green, nothing new to publish, :3191-3193)
//      else if (needsReview && !reviewerApproved)    → issueOrShadow(shadow,...) (the independent reviewer rejected it, :3194-3205)
//      else if (blocksPublish)                       → issueOrShadow(shadow,...) (the change-coverage gate holds the PR, :3206-3217)
//      else if (shadow)                              → shadow-log (:3218-3220)
//      else                                          → pr (the green publish path, :3221-3240)
//
// Every condition is checked in this EXACT order — precedence is the safety property. A fail
// verdict short-circuits before any pass-path check runs; a reviewer rejection is checked BEFORE
// blocksPublish; blocksPublish is checked BEFORE shadow. Reordering any of these branches would
// silently change which side effect fires for evidence that satisfies more than one condition.
// Note: precedence (which branch's OWN condition wins) and the shadow-fold (whether that winning
// branch's issue/pr collapses to shadow-log) are orthogonal — shadow never changes WHICH branch
// wins, only what side effect that branch ultimately produces.

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { RunDecision, type SideEffect } from "./run-decision.ts";

export interface RunEvidence {
  verdict: RunVerdict;
  generating: boolean;
  needsReview: boolean;
  reviewerApproved: boolean;
  blocksPublish: boolean;
  shadow: boolean;
  // app.report.onFailure (pipeline.ts:3337) — report()'s top-guard: `if (onFailure !==
  // "github-issue")` silently suppresses the WHOLE switch for fail/invalid (no Issue filed).
  onFailure: string;
}

// Ports report()'s guard + switch (pipeline.ts:3337-3360). Shared by every "not pass" call site.
// Folds BOTH confirmed fixes:
//   FIX 2 — the onFailure top-guard (:3337-3340): fail/invalid go silent (none) when
//   `onFailure !== "github-issue"`. flaky/infra-error are unaffected either side of the guard
//   (flaky's outcome string is set identically inside the guard branch itself; infra-error is
//   "none" regardless).
//   FIX 1 — shadow suppression: fail/invalid route through issueOrShadow(shadow,...)
//   (pipeline.ts:3344/3349, issueOrShadow itself at :3363-3378) — shadow:true collapses the
//   would-be Issue into "shadow-log". flaky/infra-error never call issueOrShadow, so they are
//   shadow-invariant.
function reportSideEffect(verdict: RunVerdict, onFailure: string, shadow: boolean): SideEffect {
  if (onFailure !== "github-issue") {
    // report()'s top-guard (:3337-3340) — suppresses the switch before issueOrShadow is ever
    // reached, so shadow is irrelevant once this guard fires.
    return verdict === "flaky" ? "quarantine" : "none";
  }
  switch (verdict) {
    case "fail":
      return shadow ? "shadow-log" : "issue";
    case "invalid":
      return shadow ? "shadow-log" : "issue";
    case "infra-error":
      return "none";
    case "flaky":
      return "quarantine";
    default:
      // "pass" and "skipped" never reach report() through this helper — decide() routes them
      // through the skipped-exit / pass-path branches BEFORE calling reportSideEffect.
      return "none";
  }
}

export function decide(ev: RunEvidence): RunDecision {
  // Branch: the two early "skipped" exits (classify-skip :1263-1267, agent no-op :2226-2234) —
  // both silent, regardless of `generating` (classify-skip fires before generating is even
  // decided; agent no-op fires only when generating=true but produces nothing to publish).
  if (ev.verdict === "skipped") {
    return RunDecision.of("skipped", "none");
  }

  // Branch: verdict !== "pass" delegates to report()'s guard + switch (pipeline.ts:3186-3190
  // calls report() directly; the static-gate/health-preflight early-returns at :2306-2337 do too).
  if (ev.verdict !== "pass") {
    return RunDecision.of(ev.verdict, reportSideEffect(ev.verdict, ev.onFailure, ev.shadow));
  }

  // From here, verdict === "pass" — the mainline pass-path chain (pipeline.ts:3191-3240). This
  // chain does NOT go through report()/its onFailure guard (that guard is report()-only, per
  // pipeline.ts:3337) — but every branch that would call issueOrShadow directly (needsReview
  // rejection :3197, blocksPublish :3209) still folds shadow -> shadow-log, same as the green
  // publish path already did.
  if (!ev.generating) {
    // Regression passed: there are no new tests to publish (pipeline.ts:3191-3193).
    return RunDecision.of("pass", "none");
  }

  if (ev.needsReview && !ev.reviewerApproved) {
    // Green in the harness BUT the independent reviewer rejected it — issueOrShadow(shadow,...)
    // (pipeline.ts:3194-3205).
    return RunDecision.of("pass", ev.shadow ? "shadow-log" : "issue");
  }

  if (ev.blocksPublish) {
    // Green AND reviewer-approved, but change-coverage enforce holds the PR —
    // issueOrShadow(shadow,...) (pipeline.ts:3206-3217).
    return RunDecision.of("pass", ev.shadow ? "shadow-log" : "issue");
  }

  if (ev.shadow) {
    // Shadow mode: green would open a PR, but only logs (pipeline.ts:3218-3220).
    return RunDecision.of("pass", "shadow-log");
  }

  // The green publish path (pipeline.ts:3221-3240).
  return RunDecision.of("pass", "pr");
}

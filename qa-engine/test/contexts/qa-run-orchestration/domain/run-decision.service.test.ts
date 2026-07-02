import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type RunEvidence } from "@contexts/qa-run-orchestration/domain/run-decision.service.ts";

// RunDecisionService.decide() (Task D.3) — THE R1 anti-false-green hotspot. Consolidates the
// scattered six-verdict policy from src/pipeline.ts into ONE pure, auditable function. Each branch
// below is PORTED VERBATIM (never rewritten) from its legacy site, in the legacy's own precedence
// order:
//
//   report()'s switch (src/pipeline.ts:3342-3360) — reused across every "not pass" call site
//   (static-gate invalid/infra-error :2306-2325, health-preflight infra-error :2330-2337, and the
//   mainline decide-chain's first branch :3186-3190):
//     case "fail"        → issue
//     case "invalid"     → issue
//     case "infra-error" → none (log-only, never reported as a bug)
//     case "flaky"       → quarantine (no PR, no Issue)
//
//   Two more EARLY "skipped" exits never reach report() at all (classify-skip :1266, agent no-op
//   :2231) — both are silent (no report() call, no publish/openIssue), which decide() must model
//   as sideEffect "none".
//
//   The mainline pass-path chain (src/pipeline.ts:3186-3241, "TODAY'S EXACT PATH" — flag-OFF specTriage):
//     if (verdict !== "pass")                          → delegates to report()'s switch above
//     else if (!generating)                             → none (regression green, nothing new)
//     else if (needsReview && !reviewerApproved)         → issue (reviewer rejected)
//     else if (blocksPublish)                            → issue (coverage gate holds the PR)
//     else if (shadow)                                   → shadow-log
//     else                                                → pr (publish)
//
// A dedicated test per branch FIRST (RED), then the minimal port (GREEN).

function baseEvidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    verdict: "pass",
    generating: true,
    needsReview: true,
    reviewerApproved: true,
    blocksPublish: false,
    shadow: false,
    onFailure: "github-issue",
    ...overrides,
  };
}

// ── report()'s switch (src/pipeline.ts:3342-3360), reached whenever verdict !== "pass" ─────────

test("decide: verdict=fail -> issue (report() case 'fail', pipeline.ts:3343-3347)", () => {
  const decision = decide(baseEvidence({ verdict: "fail" }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: verdict=invalid -> issue (report() case 'invalid', pipeline.ts:3348-3352)", () => {
  const decision = decide(baseEvidence({ verdict: "invalid" }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: verdict=infra-error -> none (report() case 'infra-error', pipeline.ts:3353-3355 — log-only, never reported as a bug)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error" }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky -> quarantine (report() case 'flaky', pipeline.ts:3356-3359 — no PR, no Issue)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky" }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

// ── FIX 1: shadow suppression — report()'s fail/invalid route through issueOrShadow(shadow,...)
// (pipeline.ts:3344/3349, issueOrShadow itself at :3363-3378) — shadow:true collapses the would-be
// Issue into "shadow-log", never a real openIssue call. flaky/infra-error are shadow-invariant
// (report()'s switch never calls issueOrShadow for those two cases).

test("decide: verdict=fail + shadow -> shadow-log (report() case 'fail' routes through issueOrShadow(shadow,...), pipeline.ts:3344)", () => {
  const decision = decide(baseEvidence({ verdict: "fail", shadow: true }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: verdict=invalid + shadow -> shadow-log (report() case 'invalid' routes through issueOrShadow(shadow,...), pipeline.ts:3349)", () => {
  const decision = decide(baseEvidence({ verdict: "invalid", shadow: true }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: verdict=infra-error + shadow -> none (shadow-invariant — report()'s 'infra-error' case never calls issueOrShadow, pipeline.ts:3353-3355)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error", shadow: true }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky + shadow -> quarantine (shadow-invariant — report()'s 'flaky' case never calls issueOrShadow, pipeline.ts:3356-3359)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky", shadow: true }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

// ── FIX 2: the onFailure top-guard (report(), pipeline.ts:3337-3340) — gates the WHOLE switch.
// `if (onFailure !== "github-issue")`: for fail/invalid, NO issue is filed (silent "none"). flaky's
// outcome string is set identically inside the guard branch itself, and infra-error is "none"
// either way — so onFailure never changes those two verdicts' sideEffect.

test("decide: verdict=fail + onFailure!=='github-issue' -> none (report()'s top-guard, pipeline.ts:3337-3340, silently suppresses the whole switch)", () => {
  const decision = decide(baseEvidence({ verdict: "fail", onFailure: "none" }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=invalid + onFailure!=='github-issue' -> none (report()'s top-guard, pipeline.ts:3337-3340, silently suppresses the whole switch)", () => {
  const decision = decide(baseEvidence({ verdict: "invalid", onFailure: "none" }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky + onFailure!=='github-issue' -> quarantine (unaffected — the guard branch itself sets the SAME 'flaky — quarantined' outcome, pipeline.ts:3338)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky", onFailure: "none" }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

test("decide: verdict=infra-error + onFailure!=='github-issue' -> none (unaffected — infra-error is 'none' either side of the guard)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error", onFailure: "none" }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=fail + onFailure!=='github-issue' + shadow -> none (the onFailure guard is checked BEFORE issueOrShadow is ever reached — shadow is irrelevant once the guard suppresses the switch)", () => {
  const decision = decide(baseEvidence({ verdict: "fail", onFailure: "none", shadow: true }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "none");
});

// ── Two early "skipped" exits (silent — never reach report()) ───────────────────────────────────

test("decide: verdict=skipped (classify-skip, pipeline.ts:1263-1267) -> none", () => {
  const decision = decide(baseEvidence({ verdict: "skipped", generating: false }));
  assert.equal(decision.verdict, "skipped");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=skipped (agent no-op, pipeline.ts:2226-2234) -> none", () => {
  const decision = decide(baseEvidence({ verdict: "skipped", generating: true }));
  assert.equal(decision.verdict, "skipped");
  assert.equal(decision.sideEffect, "none");
});

// ── The mainline pass-path chain (pipeline.ts:3186-3241) — verdict === "pass" ───────────────────

test("decide: pass + !generating -> none (regression green, no new tests to publish, pipeline.ts:3191-3193)", () => {
  const decision = decide(baseEvidence({ verdict: "pass", generating: false }));
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "none");
});

test("decide: pass + generating + needsReview + !reviewerApproved -> issue (reviewer rejected, pipeline.ts:3194-3205)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: pass + generating + reviewer OK + blocksPublish -> issue (coverage gate holds the PR, pipeline.ts:3206-3217)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: true }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: pass + generating + reviewer OK + no coverage block + shadow -> shadow-log (pipeline.ts:3218-3220)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, blocksPublish: false, shadow: true }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: pass + generating + reviewer OK + no coverage block + !shadow -> pr (the green publish path, pipeline.ts:3221-3240)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, blocksPublish: false, shadow: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "pr");
});

test("decide: needsReview=false short-circuits the reviewer-rejection branch even if reviewerApproved=false (pipeline.ts:3194 guard is `needsReview && !approved`)", () => {
  // Mirrors apps that set qa.needsReview=false (e.g. the crossApp/adjudicator scenario fixtures) —
  // reviewerApproved is irrelevant when the app never asked for review; the chain falls through to
  // the coverage/shadow/publish branches exactly like a reviewer-approved run would.
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: false, reviewerApproved: false, blocksPublish: false, shadow: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "pr");
});

// ── Precedence pins: earlier branches must win over later ones when multiple conditions hold ────

test("decide: precedence — verdict!=='pass' wins over every pass-path condition (a fail verdict ignores blocksPublish/needsReview, shadow:false so no shadow-fold applies)", () => {
  const decision = decide(
    baseEvidence({ verdict: "fail", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: false }),
  );
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "issue", "fail must route through report()'s switch, not fall through to shadow/coverage/reviewer checks");
});

test("decide: precedence — verdict!=='pass' + shadow:true folds to shadow-log (report()'s fail case routes through issueOrShadow(shadow,...), pipeline.ts:3344/3371-3374)", () => {
  const decision = decide(
    baseEvidence({ verdict: "fail", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "shadow-log", "shadow uniformly folds every would-be issue/pr, even for a fail verdict short-circuiting before the pass-path");
});

test("decide: precedence — reviewer rejection wins over blocksPublish and shadow (pipeline.ts checks needsReview/approved BEFORE blocksPublish BEFORE shadow) — shadow:true folds the outcome to shadow-log, not issue (issueOrShadow, pipeline.ts:3197-3204)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.sideEffect, "shadow-log", "reviewer rejection (checked first in the else-if chain) must win over both blocksPublish and shadow's own branch — but the shadow flag still folds issue->shadow-log via issueOrShadow");
});

test("decide: precedence — blocksPublish wins over shadow's own branch (coverage gate is checked BEFORE the shadow branch) — shadow:true folds the outcome to shadow-log, not issue (issueOrShadow, pipeline.ts:3209-3216)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.sideEffect, "shadow-log", "blocksPublish (checked before the shadow branch in the else-if chain) must win over the shadow-log branch's OWN precedence slot — but the shadow flag still folds issue->shadow-log via issueOrShadow");
});

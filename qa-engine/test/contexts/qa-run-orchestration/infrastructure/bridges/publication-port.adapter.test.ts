// test/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.test.ts
// RED-first (Task E.0): PublicationPortAdapter delegates the routing decision to the REAL
// PublishDecisionService.decide() (workspace-and-publication's pure decide step — the legacy
// E2e/Code/Context/Subset fan-out collapsed here per the plan) and dispatches the resulting
// PublishOutcome to the REAL side-effect adapter (GitHubPrAdapter / GitHubIssueAdapter /
// ShadowLogAdapter). THIN — no new routing policy, PublishDecisionService owns it verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts";
import { ShadowLogAdapter } from "@contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts";

function fakePr(): GitHubPrAdapter {
  return new GitHubPrAdapter({
    createPullRequest: async () => ({ url: "https://github.com/org/app/pull/1", nodeId: "n1", number: 1 }),
    enableAutoMerge: async () => {},
    mergePullRequest: async () => {},
  });
}
function fakeIssue(): GitHubIssueAdapter {
  return new GitHubIssueAdapter(async () => ({ url: "https://github.com/org/app/issues/5" }));
}

test("publish() routes to GitHubPrAdapter when the decision resolves to 'pr' (green+approved+covered+e2eChanged)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /pr/);
});

test("publish() routes to GitHubIssueAdapter when the decision resolves to 'issue' (fail verdict)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [{ name: "checkout", status: "fail" }], logs: "boom" });

  assert.match(result.outcome, /issue/);
});

test("publish() routes to ShadowLogAdapter when shadow:true, regardless of verdict", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  let logged: string | undefined;
  const shadowLog = new ShadowLogAdapter((msg) => { logged = msg; });
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: true, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /shadow/);
  assert.ok(logged, "shadow mode must log instead of hitting the real GitHub adapters");
});

test("publish() produces a noop outcome with no side effect when verdict is skipped", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: false,
  });

  const result = await adapter.publish({ verdict: "skipped", cases: [], logs: "" });

  assert.match(result.outcome, /noop/);
});

// ── Fix 5 (engram #961, CRITICAL) — the decision's REAL per-run reviewerApproved/coverageBlocks/
// e2eChanged must override the adapter's static ctx when the caller supplies them. Previously
// PublicationPort.publish() only carried {verdict,cases,logs}, so RunQaUseCase's genuinely
// computed reviewerApproved (run-qa.use-case.ts ~line 511) never reached this adapter — a
// green-but-reviewer-rejected run would still publish a PR because ctx.reviewerApproved defaulted
// to a static `true`. Backward-compatible: absent fields still fall back to ctx (existing
// stubs/tests keep working unchanged).

test("publish() prefers decision.reviewerApproved (dynamic) over ctx.reviewerApproved (static) when both are supplied", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  // ctx says reviewerApproved:true (the OLD static default), but the decision's dynamic value says
  // the reviewer actually rejected this run — the dynamic value must win, routing to "issue" not "pr".
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", reviewerApproved: false });

  assert.match(result.outcome, /issue/, "a dynamic reviewerApproved:false must override the static ctx default and hold the PR");
});

test("publish() falls back to ctx.reviewerApproved (static) when the decision omits it (backward-compat)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /pr/, "with no dynamic override, the static ctx.reviewerApproved:true must still apply");
});

test("publish() prefers decision.coverageBlocks (dynamic) over ctx.coverageBlocks (static) when both are supplied", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  // ctx says coverageBlocks:false (the OLD static default), but the dynamic value says an
  // enforce-mode coverage-fail must hold the PR — the dynamic value must win.
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", coverageBlocks: true });

  assert.match(result.outcome, /issue/, "a dynamic coverageBlocks:true must override the static ctx default and hold the PR");
});

test("publish() prefers decision.e2eChanged (dynamic) over ctx.e2eChanged (static) when both are supplied", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  // ctx says e2eChanged:true (the OLD static default), but the dynamic value says no e2e/ files
  // actually changed this run — publish() should reflect the REAL signal when supplied.
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", e2eChanged: false });

  assert.match(result.outcome, /noop/, "a dynamic e2eChanged:false must override the static ctx default (green with no e2e changes publishes nothing)");
});

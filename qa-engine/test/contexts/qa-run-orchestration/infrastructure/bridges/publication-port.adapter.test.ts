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

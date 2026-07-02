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

// ── F3 (CRITICAL, cross-repo Issue routing) — Issue creation routes to decision.issueRepo when
// supplied; PR creation ALWAYS targets ctx.repo (the primary repo), never the trigger repo. ──────

test("F3: publish() routes Issue creation to decision.issueRepo (the triggering service repo), not ctx.repo (the primary)", async () => {
  const decide = new PublishDecisionService();
  let issueRepoSeen: string | undefined;
  const issue = { open: async (repo: string) => { issueRepoSeen = repo; return { url: "https://github.com/org/orders-svc/issues/9", number: 9 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "", issueRepo: "org/orders-svc" });

  assert.match(result.outcome, /issue/);
  assert.equal(issueRepoSeen, "org/orders-svc", "the Issue must open in the TRIGGERING service repo, not ctx.repo");
});

test("F3: publish() still targets ctx.repo for a PR even when issueRepo is supplied (PR never targets the trigger repo)", async () => {
  const decide = new PublishDecisionService();
  let prRepoSeen: string | undefined;
  const pr = { openWithAutoMerge: async (repo: string) => { prRepoSeen = repo; return { url: "https://github.com/org/app/pull/1", number: 1 }; } };
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", issueRepo: "org/orders-svc" });

  assert.match(result.outcome, /pr/);
  assert.equal(prRepoSeen, "org/app", "PR creation must always target ctx.repo (the primary repo), never the trigger repo, even when issueRepo is present");
});

test("F3: publish() falls back to ctx.repo for an Issue when issueRepo is absent (ordinary monorepo run)", async () => {
  const decide = new PublishDecisionService();
  let issueRepoSeen: string | undefined;
  const issue = { open: async (repo: string) => { issueRepoSeen = repo; return { url: "https://github.com/org/app/issues/2", number: 2 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "" });

  assert.match(result.outcome, /issue/);
  assert.equal(issueRepoSeen, "org/app", "absent issueRepo must fall back to ctx.repo (the ordinary, non-cross-repo case)");
});

// ── F4 (CRITICAL security invariant) — logs + case details + names are sanitized before reaching
// an Issue/PR body. Absent sanitizer -> identity (backward-compat). ──────────────────────────────

test("F4: publish() applies the injected sanitize() to logs before they reach the Issue body", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/3", number: 3 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "leaked token sk-abc123XYZ during the run" });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("sk-abc123XYZ"), `the secret-looking token must be sanitized out of the Issue body — got: ${bodySeen}`);
  assert.ok(bodySeen.includes("[REDACTED_SECRET]"), "the sanitized replacement must appear in the rendered body");
});

test("F4: publish() applies the injected sanitize() to each failing case's name and detail", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/4", number: 4 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "fail",
    cases: [{ name: "checkout leaks sk-def456UVW", status: "fail", detail: "assertion failed near sk-ghi789RST" }],
    logs: "",
  });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("sk-def456UVW"), `the case name's secret must be sanitized — got: ${bodySeen}`);
  assert.ok(!bodySeen.includes("sk-ghi789RST"), `the case detail's secret must be sanitized — got: ${bodySeen}`);
});

test("F4: publish() falls back to identity when no sanitizer is wired (backward-compat)", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/5", number: 5 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "plain text, no secrets" });

  assert.match(result.outcome, /issue/);
  assert.ok(bodySeen.includes("plain text, no secrets"), "with no sanitizer wired, the body must pass through unchanged (identity default)");
});

// ── SHADOW FIDELITY (live-monitoring find) ─────────────────────────────────────────────────────
// Shadow mode's purpose is previewing the UNDERLYING side effect: a fail run's suppressed action
// is an ISSUE, so the shadow log must say "would open Issue" — previously the shadow branch
// unconditionally logged "would open PR" for every verdict (observed live: a fail run logging
// 'would open PR ... title="qa-bot: fail run"').

test("shadow fidelity: a FAIL run's shadow preview logs the would-be ISSUE, not a PR", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const logs: string[] = [];
  const shadowLog = new ShadowLogAdapter((msg) => { logs.push(msg); });
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: true, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "" });

  assert.match(result.outcome, /shadow/);
  assert.match(result.outcome, /would: issue/, "the outcome string must name the underlying action");
  assert.ok(logs.some((l) => l.includes("would open Issue")), `expected an Issue preview, got: ${logs.join(" | ")}`);
  assert.ok(!logs.some((l) => l.includes("would open PR")), "a fail run must never preview a PR");
});

test("shadow fidelity: a PASS run's shadow preview still logs the would-be PR", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const logs: string[] = [];
  const shadowLog = new ShadowLogAdapter((msg) => { logs.push(msg); });
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: true, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /would: pr/);
  assert.ok(logs.some((l) => l.includes("would open PR")), `expected a PR preview, got: ${logs.join(" | ")}`);
});

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
import { renderIssue, renderPrBody } from "@contexts/workspace-and-publication/domain/render-publication.ts";

// sdd/migration-remediation Slice 4 (D-P1a): `render` is now a REQUIRED collaborator (the SAME
// fail-closed posture as `sanitize`) — every construction in this file wires one. Tests that only
// exercise ROUTING (which side effect fires, in what order, with what repo/branch) use this trivial
// fake — body CONTENT is irrelevant to those assertions (they only check result.outcome, never
// bodySeen). Tests that DO assert on body content wire the REAL renderIssue/renderPrBody via
// realRender() below instead — the SAME collaborator composition-root.ts wires in production.
function fakeRender(): { issue: () => string; prBody: () => string } {
  return { issue: () => "issue-body", prBody: () => "pr-body" };
}
function realRender(): { issue: typeof renderIssue; prBody: typeof renderPrBody } {
  return { issue: renderIssue, prBody: renderPrBody };
}

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
// WS5.4b — sanitize is now a REQUIRED collaborator (fail-closed default): every construction site in
// this file wires an explicit identity sanitizer unless it is specifically testing a REAL sanitizer's
// effect. This is NOT the same as the old default-to-identity behavior — the constructor now THROWS
// if sanitize is omitted (see the dedicated test below); every other test in this file passes this
// helper explicitly so it keeps exercising routing/rendering behavior, not the fail-closed gate itself.
const identitySanitize = (text: string) => text;

// PROD-BLOCKER fix: the "pr" route previously called GitHubPrAdapter.openWithAutoMerge() directly
// against ctx.branch — a branch that was NEVER created/committed/pushed (VcsWriteAdapter, the only
// VcsWritePort implementation, was never instantiated anywhere in composition-root.ts — grep-
// confirmed zero references outside its own test). Every green, reviewer-approved, non-shadow run
// failed at the PR step (GitHub 404/422 on a nonexistent branch). `vcsWrite` is a NEW required
// collaborator (duck-typed per this file's own confinement pattern — see the header note on why
// this bridge depends only on LOCAL structural interfaces, never a concrete workspace-and-publication
// import) invoked ONLY on the "pr" route, BEFORE pr.openWithAutoMerge — mirroring the legacy
// contract (src/integrations/publish.ts's publishChanges: checkout -B -> add -> commit -> push ->
// THEN createPullRequest).
function fakeVcsWrite(calls: string[]): { publish: (input: { mirrorDir: string; branch: string; sha: string }) => Promise<{ changed: boolean }> } {
  return { publish: async () => { calls.push("vcsWrite"); return { changed: true }; } };
}

test("publish() routes to GitHubPrAdapter when the decision resolves to 'pr' (green+approved+covered+e2eChanged)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = fakeVcsWrite([]);
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.match(result.outcome, /pr/);
});

test("publish() routes to GitHubIssueAdapter when the decision resolves to 'issue' (fail verdict)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const vcsWrite = fakeVcsWrite([]);
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.match(result.outcome, /pr/, "with no dynamic override, the static ctx.reviewerApproved:true must still apply");
});

test("publish() prefers decision.coverageBlocks (dynamic) over ctx.coverageBlocks (static) when both are supplied", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  // ctx says coverageBlocks:false (the OLD static default), but the dynamic value says an
  // enforce-mode coverage-fail must hold the PR — the dynamic value must win.
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const vcsWrite = fakeVcsWrite([]);
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", issueRepo: "org/orders-svc", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.match(result.outcome, /pr/);
  assert.equal(prRepoSeen, "org/app", "PR creation must always target ctx.repo (the primary repo), never the trigger repo, even when issueRepo is present");
});

test("F3: publish() falls back to ctx.repo for an Issue when issueRepo is absent (ordinary monorepo run)", async () => {
  const decide = new PublishDecisionService();
  let issueRepoSeen: string | undefined;
  const issue = { open: async (repo: string) => { issueRepoSeen = repo; return { url: "https://github.com/org/app/issues/2", number: 2 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "" });

  assert.match(result.outcome, /issue/);
  assert.equal(issueRepoSeen, "org/app", "absent issueRepo must fall back to ctx.repo (the ordinary, non-cross-repo case)");
});

// ── F4 (CRITICAL security invariant) — logs + case details + names are sanitized before reaching
// an Issue/PR body. Absent sanitizer -> identity (backward-compat). ──────────────────────────────

// sdd/migration-remediation Slice 4 (D-P1a): the OLD version of this test asserted that `logs` (a
// raw execution-log string) was sanitized INTO the Issue body — that premise is now the exact
// regression this slice fixes: renderIssue's own input shape carries no `logs` field at all, so a
// raw log dump structurally cannot reach the body through this adapter anymore (see
// render-publication.ts's own header). Replaced with the render-content-level assertion: the Issue
// body never contains raw log text, and the footer points at the run artifacts instead.
test("F4 (Slice 4 update): publish() never embeds raw execution logs in the Issue body — logs live in the run artifacts", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/3", number: 3 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "leaked token sk-abc123XYZ during the run" });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("sk-abc123XYZ"), `raw logs must never reach the Issue body at all — got: ${bodySeen}`);
  assert.match(bodySeen, /Full trace \+ logs in the run artifacts/, "the body must point at the run artifacts instead of embedding logs");
});

test("F4: publish() applies the injected sanitize() to each failing case's name and detail", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/4", number: 4 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize, render: realRender() }, {
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

// ── PROD-BLOCKER fix (vcsWrite: stage/commit/push before the PR call) ─────────────────────────────
// See fakeVcsWrite's own header note above for the full bug description. These tests pin: (1) the
// vcsWrite collaborator runs BEFORE pr.openWithAutoMerge on the "pr" route, in that exact order;
// (2) issue/shadow/noop/quarantine routes NEVER invoke it (git-write is a PR-only side effect);
// (3) a "nothing changed" result from vcsWrite short-circuits — no PR call, outcome reflects noop;
// (4) a "pr" route with vcsWrite absent throws loudly at publish() time (fail-closed, WS5.4b pattern
// — checked lazily inside the "pr" case rather than the constructor, since unlike sanitize [used on
// every rendered body] vcsWrite is relevant ONLY to the "pr" route; every other test in this file
// exercising issue/shadow/noop legitimately omits it and must keep passing unchanged).

test("PROD-BLOCKER: publish() invokes vcsWrite BEFORE pr.openWithAutoMerge on the 'pr' route (call-order pinned)", async () => {
  const decide = new PublishDecisionService();
  const order: string[] = [];
  const pr = { openWithAutoMerge: async () => { order.push("pr.openWithAutoMerge"); return { url: "https://github.com/org/app/pull/1", number: 1 }; } };
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => { order.push("vcsWrite.publish"); return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.match(result.outcome, /pr/);
  assert.deepEqual(order, ["vcsWrite.publish", "pr.openWithAutoMerge"], "the git write must land BEFORE the PR is opened — the legacy contract's exact ordering");
});

test("PROD-BLOCKER: publish() threads mirrorDir/branch/sha from the decision + ctx into vcsWrite.publish", async () => {
  const decide = new PublishDecisionService();
  let seen: { mirrorDir: string; branch: string; sha: string } | undefined;
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async (input: { mirrorDir: string; branch: string; sha: string }) => { seen = input; return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.deepEqual(seen, { mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" }, "vcsWrite must push to the SAME branch the PR is opened against, not an independently-computed one");
});

test("PROD-BLOCKER: publish() never invokes vcsWrite on the 'issue' route (fail verdict)", async () => {
  const decide = new PublishDecisionService();
  let vcsWriteCalled = false;
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => { vcsWriteCalled = true; return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "boom" });

  assert.match(result.outcome, /issue/);
  assert.equal(vcsWriteCalled, false, "vcsWrite is a PR-only side effect — an Issue route must never touch git");
});

test("PROD-BLOCKER: publish() never invokes vcsWrite on the 'shadow' route, even when the underlying decision would be 'pr'", async () => {
  const decide = new PublishDecisionService();
  let vcsWriteCalled = false;
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => { vcsWriteCalled = true; return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: true, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /shadow/);
  assert.equal(vcsWriteCalled, false, "shadow mode must stay entirely side-effect-free — it only PREVIEWS what would happen, never touches real git");
});

test("PROD-BLOCKER: publish() never invokes vcsWrite on a 'noop' route (green, no e2e/ changes)", async () => {
  const decide = new PublishDecisionService();
  let vcsWriteCalled = false;
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => { vcsWriteCalled = true; return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", e2eChanged: false });

  assert.match(result.outcome, /noop/);
  assert.equal(vcsWriteCalled, false, "a noop route (nothing to publish) must never touch git");
});

test("PROD-BLOCKER: publish() never invokes vcsWrite on the 'quarantine' route (flaky verdict)", async () => {
  const decide = new PublishDecisionService();
  let vcsWriteCalled = false;
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => { vcsWriteCalled = true; return { changed: true }; } };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "flaky", cases: [], logs: "" });

  assert.match(result.outcome, /quarantine/);
  assert.equal(vcsWriteCalled, false, "flaky routes to quarantine, never a PR — git must stay untouched");
});

test("PROD-BLOCKER: publish() short-circuits to a noop-shaped outcome when vcsWrite reports nothing changed (skip-if-no-changes) — no PR call", async () => {
  const decide = new PublishDecisionService();
  let prCalled = false;
  const pr = { openWithAutoMerge: async () => { prCalled = true; return { url: "https://github.com/org/app/pull/1", number: 1 }; } };
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = { publish: async () => ({ changed: false }) };
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.equal(prCalled, false, "no changes to publish -> the PR must never be opened");
  assert.match(result.outcome, /noop/, "the outcome must honestly reflect that nothing was published, matching legacy's own no-change skip semantic (CLAUDE.md-documented: a green run with no e2e/ changes opens no PR)");
});

test("PROD-BLOCKER: publish() throws loudly on the 'pr' route when vcsWrite is absent (fail-closed — never silently opens a PR against a phantom branch)", async () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  // vcsWrite is deliberately omitted (it is OPTIONAL at the type level — see PublicationPortCollaborators'
  // own doc for why) to prove the fail-closed runtime guard on the "pr" route specifically.
  const adapter = new PublicationPortAdapter(
    { decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() },
    { repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true },
  );

  await assert.rejects(
    () => adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" }),
    /vcsWrite/i,
    "a 'pr' route with no vcsWrite collaborator wired must throw naming the gap, never silently call pr.openWithAutoMerge against an unpushed branch",
  );
});

// WS5.4b (fail-closed publication default) — sanitize is now REQUIRED, not defaulted to identity.
// A future composition that forgets to inject the real sanitizer must fail LOUDLY at construction
// time, never silently publish unsanitized Issue/PR bodies. Replaces the old "falls back to identity
// when no sanitizer is wired" test, whose entire premise (an absent sanitizer is a valid, silent
// default) is exactly the latent fail-open this fix closes.
test("WS5.4b: constructor THROWS when sanitize is omitted (fail-closed, not identity default)", () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  assert.throws(
    () =>
      new PublicationPortAdapter(
        // @ts-expect-error — sanitize is intentionally omitted to prove the fail-closed constructor guard
        { decide, pr, issue, shadowLog },
        { repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true },
      ),
    /sanitize/i,
    "the constructor must throw naming the missing sanitize collaborator, never silently default to identity",
  );
});

// sdd/migration-remediation Slice 4 (D-P1a): the SAME fail-closed posture as WS5.4b's sanitize guard
// immediately above, now also enforced for the `render` collaborator — a composition that forgets to
// wire the real renderIssue/renderPrBody must throw loudly at construction time, never silently fall
// back to a raw-log embed (the regression this slice fixes).
test("Slice 4: constructor THROWS when render is omitted (fail-closed, no raw-log fallback)", () => {
  const decide = new PublishDecisionService();
  const pr = fakePr();
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  assert.throws(
    () =>
      new PublicationPortAdapter(
        // @ts-expect-error — render is intentionally omitted to prove the fail-closed constructor guard
        { decide, pr, issue, shadowLog, sanitize: identitySanitize },
        { repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true },
      ),
    /render/i,
    "the constructor must throw naming the missing render collaborator, never silently fall back to a raw-log embed",
  );
});

// sdd/migration-remediation Slice 4 (D-P1a): the OLD version of this test proved identity-sanitize
// passthrough via raw `logs` text reaching the body — that channel no longer exists (renderIssue
// carries no logs field, see F4's own Slice-4-update test above). Re-targeted at a field the render
// functions DO carry through unchanged with an identity sanitizer: a failing case's own name.
test("WS5.4b: an explicitly-injected identity sanitize is still a VALID, deliberate choice", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/5", number: 5 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [{ name: "plain text, no secrets", status: "fail" }], logs: "" });

  assert.match(result.outcome, /issue/);
  assert.ok(bodySeen.includes("plain text, no secrets"), "an explicitly-injected identity sanitizer passes text through unchanged — this is a deliberate opt-in, not a silent default");
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
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
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: fakeRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: true, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "" });

  assert.match(result.outcome, /would: pr/);
  assert.ok(logs.some((l) => l.includes("would open PR")), `expected a PR preview, got: ${logs.join(" | ")}`);
});

// ── WS3.1 (adjudication -> Issue body) — the FixLoop's deterministic adjudicator verdict (class/
// confidence/reason) is computed and gates learning, but was previously silently dropped at the
// publish() boundary — the human reading the GitHub Issue never saw the engine's own diagnosis.
// OPTIONAL field: absent -> the "Engine adjudication" section is omitted entirely (backward-compat
// for every pre-existing caller/stub that never threads it). Present -> rendered through the SAME
// injected sanitizer the logs/case fields already use. ──────────────────────────────────────────

test("WS3.1: publish() renders an 'Engine adjudication' section in the Issue body when adjudication is present", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/6", number: 6 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "fail",
    cases: [{ name: "checkout", status: "fail", detail: "server error" }],
    logs: "x",
    adjudication: { class: "app_defect", confidence: "high", reason: "App defect detected: backend returned a 5xx server error (status 503)" },
  });

  assert.match(result.outcome, /issue/);
  assert.match(bodySeen, /Engine adjudication/);
  assert.match(bodySeen, /app_defect/);
  assert.match(bodySeen, /high/);
  assert.match(bodySeen, /App defect detected: backend returned a 5xx server error \(status 503\)/);
});

test("WS3.1: publish() omits the 'Engine adjudication' section entirely when adjudication is absent (backward-compat)", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/7", number: 7 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "x" });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("Engine adjudication"), `no adjudication was supplied, so the section must be entirely absent — got: ${bodySeen}`);
});

test("WS3.1: publish() words a low-confidence adjudication as an engine guess (hint), not a firm diagnosis", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/8", number: 8 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "fail",
    cases: [],
    logs: "x",
    adjudication: { class: "generated_test_defect", confidence: "low", reason: "No progress and ambiguous failure — stopping fix-loop for human review." },
  });

  assert.match(result.outcome, /issue/);
  assert.match(bodySeen, /Engine adjudication \(low confidence — treat as a hint\)/, `expected the low-confidence hedge wording — got: ${bodySeen}`);
});

test("WS3.1: publish() sanitizes the adjudication reason through the SAME injected sanitizer as logs/cases", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/9", number: 9 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "fail",
    cases: [],
    logs: "x",
    adjudication: { class: "app_defect", confidence: "high", reason: "leaked token sk-abc123XYZ during adjudication" },
  });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("sk-abc123XYZ"), `the adjudication reason's secret must be sanitized — got: ${bodySeen}`);
  assert.ok(bodySeen.includes("[REDACTED_SECRET]"), "the sanitized replacement must appear in the rendered body");
});

// ── Follow-up #28 (reviewer-outage observability hardening) — a fleet-wide reviewer outage
// (ReviewPortAdapter's catch mapping any session failure to {approved:false, parsed:false,
// rationale:"reviewer unavailable: <reason>"}) previously degraded every green run to
// Issue-instead-of-PR with the ONLY trace being a console.error at the moment of failure — never in
// the Issue body, never in RunOutcome. `reviewerNote` (OPTIONAL, mirrors adjudication's own
// backward-compat precedent immediately above) threads the reviewer-unavailable rationale into the
// Issue body so the human reading it sees WHY there is no PR. Scope: ONLY the reviewer-unavailable
// case ever threads this — a genuine reviewer REJECTION keeps today's rendering (corrections are
// already that signal), never populating reviewerNote. ──────────────────────────────────────────

test("reviewer-outage note: publish() renders a 'Reviewer unavailable' section in the Issue body when reviewerNote is present", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/10", number: 10 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: false, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "pass",
    cases: [],
    logs: "x",
    reviewerNote: "reviewer unavailable: timed out after 360000ms",
  });

  assert.match(result.outcome, /issue/);
  assert.match(bodySeen, /Reviewer unavailable/);
  assert.match(bodySeen, /timed out after 360000ms/);
});

test("reviewer-outage note: publish() omits the 'Reviewer unavailable' section entirely when reviewerNote is absent (backward-compat)", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/11", number: 11 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "fail", cases: [], logs: "x" });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("Reviewer unavailable"), `no reviewerNote was supplied, so the section must be entirely absent — got: ${bodySeen}`);
});

test("reviewer-outage note: publish() sanitizes reviewerNote through the SAME injected sanitizer as logs/cases/adjudication", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/12", number: 12 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const sanitize = (text: string) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED_SECRET]");
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: false, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "pass",
    cases: [],
    logs: "x",
    reviewerNote: "reviewer unavailable: leaked token sk-abc123XYZ during session",
  });

  assert.match(result.outcome, /issue/);
  assert.ok(!bodySeen.includes("sk-abc123XYZ"), `the reviewerNote's secret must be sanitized — got: ${bodySeen}`);
  assert.ok(bodySeen.includes("[REDACTED_SECRET]"), "the sanitized replacement must appear in the rendered body");
});

// ── sdd/migration-remediation Slice 4 (D-P1a) — tested/isCode/parentRunId threading ──────────────
// PublicationPort.publish()'s three new optional fields reach the REAL render functions correctly:
// `tested` populates "Covers:"/"What was tested", `isCode` selects the PR body's wording, and
// `parentRunId` renders the continuation reference. Absent -> each degrades gracefully (already
// pinned at the render-publication.ts unit level; these tests pin the ADAPTER'S OWN threading).

test("Slice 4: publish() threads tested/isCode/parentRunId into the PR body render", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const pr = { openWithAutoMerge: async (_repo: string, _branch: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/pull/1", number: 1 }; } };
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = fakeVcsWrite([]);
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "pass",
    cases: [],
    logs: "",
    mirrorDir: "/mirrors/org/app",
    sha: "abc1234",
    isCode: true,
    tested: [{ flow: "parseConfig", objective: "rejects malformed YAML" }],
    parentRunId: "run-deadbeef",
  });

  assert.match(result.outcome, /pr/);
  assert.match(bodySeen, /Source-code tests generated\/updated by panchito/, "isCode:true must select the code-flavored PR wording");
  assert.match(bodySeen, /\*\*Covers:\*\*/);
  assert.match(bodySeen, /\*\*parseConfig\*\*/);
  assert.match(bodySeen, /Continuation of run-deadbeef/);
});

test("Slice 4: publish() threads tested into the Issue body render", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const issue = { open: async (_repo: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/issues/13", number: 13 }; } };
  const pr = fakePr();
  const shadowLog = new ShadowLogAdapter(() => {});
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({
    verdict: "fail",
    cases: [{ name: "checkout", status: "fail", detail: "expect failed" }],
    logs: "",
    tested: [{ flow: "Checkout", objective: "user can pay" }],
  });

  assert.match(result.outcome, /issue/);
  assert.match(bodySeen, /### What was tested/);
  assert.match(bodySeen, /\*\*Checkout\*\*/);
});

test("Slice 4: publish() with no tested/isCode/parentRunId supplied still renders a complete PR body (backward-compat, isCode defaults to e2e wording)", async () => {
  const decide = new PublishDecisionService();
  let bodySeen = "";
  const pr = { openWithAutoMerge: async (_repo: string, _branch: string, _title: string, body: string) => { bodySeen = body; return { url: "https://github.com/org/app/pull/2", number: 2 }; } };
  const issue = fakeIssue();
  const shadowLog = new ShadowLogAdapter(() => {});
  const vcsWrite = fakeVcsWrite([]);
  const adapter = new PublicationPortAdapter({ decide, pr, issue, shadowLog, sanitize: identitySanitize, vcsWrite, render: realRender() }, {
    repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true,
  });

  const result = await adapter.publish({ verdict: "pass", cases: [], logs: "", mirrorDir: "/mirrors/org/app", sha: "abc1234" });

  assert.match(result.outcome, /pr/);
  assert.match(bodySeen, /E2E tests generated\/updated by panchito/, "absent isCode falls back to the e2e-flavored wording");
  assert.ok(!bodySeen.includes("Covers:"), "no tested metadata was supplied, so the section must be absent");
  assert.ok(!bodySeen.includes("Continuation of"), "no parentRunId was supplied, so no continuation reference should render");
});

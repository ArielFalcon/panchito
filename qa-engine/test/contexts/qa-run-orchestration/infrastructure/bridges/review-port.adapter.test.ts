// test/contexts/qa-run-orchestration/infrastructure/bridges/review-port.adapter.test.ts
// RED-first (Task E.0): ReviewPortAdapter runs an INDEPENDENT reviewer session via the SAME
// generation-owned primitives GenerateTestsUseCase.generate() itself composes for its embedded
// review branch (renderReviewer / openSession(reviewerRole) / parseReview) — there is NO standalone
// "reviewer flow" export under generation/ (grep-confirmed: renderReviewer is called from exactly
// ONE place, inside generate()'s conditional review branch). This bridge is THIN: it does not
// reimplement the fail-closed formula, it reads the SAME ReviewJudgment fields the port interface
// (ports/index.ts's own comment) already documents verbatim — parsed:false is a parse MISS
// (not a rejection), distinct from a genuine approved:false. blockingCount gates blocking-vs-advisory.
// The #1 fail-closed invariant is asserted here directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/review-port.adapter.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort, ReviewJudgment } from "@contexts/generation/application/ports/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";

function fakeRuntime(output: string): AgentRuntimePort {
  return {
    openSession: async () => ({
      prompt: async () => ({ output }),
      dispose: async () => {},
    }),
  };
}

function fakeRendering(): PromptRenderingPort {
  return {
    render: () => "",
    renderMain: () => ({ text: "", sectionSizes: {} }),
    renderWorker: () => ({ text: "", sectionSizes: {} }),
    renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
    renderExplorer: () => "",
    specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
  };
}

function fakeVerdicts(judgment: ReviewJudgment): VerdictParserPort {
  return {
    parseGenerator: () => ({ specs: [] }),
    parseReview: () => judgment,
  };
}

const cases: QaCase[] = [{ name: "checkout flow", status: "pass" }];

test("review() delegates to the reviewer session and surfaces approved/corrections/rationale", async () => {
  const runtime = fakeRuntime("verdict-json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: true, corrections: [], rationale: undefined, parsed: true, valid: true, issues: [],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, true);
  assert.equal(result.parsed, true);
});

test("review() fail-closed invariant: a parse miss (parsed:false) is NEVER treated as approved", async () => {
  const runtime = fakeRuntime("garbage, not json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: true, // even if the parser's own approved defaulted true, parsed:false must win
    corrections: [], parsed: false, valid: false, issues: ["no verdict JSON found"],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.parsed, false);
  assert.equal(result.approved, false, "a parse miss must NEVER read as a real approval");
});

test("review() threads blockingCount so the caller can distinguish blocking vs advisory corrections", async () => {
  const runtime = fakeRuntime("verdict-json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: false, corrections: ["nit: rename var"], blockingCount: 0, parsed: true, valid: true, issues: [],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.blockingCount, 0);
  assert.deepEqual(result.corrections, ["nit: rename var"]);
});

test("review() prefers the run's DYNAMIC diff over the static ctx.diff (Plan 7.6), falling back when absent", async () => {
  let seenDiff: string | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenDiff = (input as { diff?: string }).diff; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], rationale: undefined, parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "STATIC-ctx-diff", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, "DYNAMIC-run-diff");
  assert.equal(seenDiff, "DYNAMIC-run-diff", "the reviewer must ground on the run's REAL diff, not the empty composition-time value");

  await adapter.review("/mirrors/org/app/e2e", cases);
  assert.equal(seenDiff, "STATIC-ctx-diff", "absent dynamic diff falls back to ctx.diff (operator / unit-test path)");
});

// ── W2 fix (F3, reviewer-corrections regeneration loop): review()'s new optional 4th `enrichment`
// argument maps priorCorrections verbatim and derives objective from intent.message ONLY when no
// manual ctx.guidance is already set (mirrors legacy's `opts.guidance ?? intent?.message`,
// src/pipeline.ts:1682 — guidance wins, intent is the fallback).

test("review() maps enrichment.priorCorrections onto ReviewInput.priorCorrections verbatim", async () => {
  let seenInput: { priorCorrections?: string[] } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { priorCorrections?: string[] }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { priorCorrections: ["fix the assertion on line 12"] });

  assert.deepEqual(seenInput?.priorCorrections, ["fix the assertion on line 12"]);
});

// ── Plan 7-R W4 (audit CRITICAL): enrichment.domSnapshot (ReviewDomGroundingPort, run-qa.use-
// case.ts) must map onto ReviewInput.domSnapshot — mirrors legacy's reviewGenerated() domSnapshot
// threading (src/pipeline.ts:1680), grounding the reviewer's UI-fact claims in the live DEV DOM.

test("review() maps enrichment.domSnapshot onto ReviewInput.domSnapshot verbatim", async () => {
  let seenInput: { domSnapshot?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { domSnapshot?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { domSnapshot: "route /owners:\n  heading: Owners" });

  assert.equal(seenInput?.domSnapshot, "route /owners:\n  heading: Owners");
});

test("review() with absent enrichment.domSnapshot omits it from ReviewInput (never fabricated)", async () => {
  let seenInput: { domSnapshot?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { domSnapshot?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {});

  assert.equal(seenInput?.domSnapshot, undefined);
});

test("review() derives objective from enrichment.intent.message when ctx.guidance is absent (legacy's opts.guidance ?? intent?.message)", async () => {
  let seenInput: { objective?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { objective?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {
    intent: { type: "feat", breaking: false, message: "add checkout flow", changedFiles: ["src/x.ts"] },
  });

  assert.equal(seenInput?.objective, "add checkout flow");
});

test("review() prefers ctx.guidance over enrichment.intent.message when both are present (guidance wins)", async () => {
  let seenInput: { objective?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { objective?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", guidance: "test the contact form",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {
    intent: { type: "feat", breaking: false, message: "add checkout flow", changedFiles: ["src/x.ts"] },
  });

  assert.equal(seenInput?.objective, undefined, "objective is only set from intent when ctx.guidance is absent — guidance itself flows through ReviewInput.guidance, not .objective");
});

test("review() with no enrichment argument omits priorCorrections/objective (unchanged prompt)", async () => {
  let seenInput: { priorCorrections?: string[]; objective?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { priorCorrections?: string[]; objective?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(seenInput?.priorCorrections, undefined);
  assert.equal(seenInput?.objective, undefined);
});

// ── W3 F2 (dual-judge round): enrichment.learnedRules is rendered via the reviewer-specific
// faithful port (renderLearnedRulesForReviewer) — active-only, matching legacy's
// renderRulesForReviewer (src/qa/learning/learning-rule.ts:299-313), NOT the generator's
// proven/experimental renderer. ─────────────────────────────────────────────────────────────────

test("review() renders enrichment.learnedRules via the reviewer-specific (active-only) faithful renderer", async () => {
  let seenInput: { learnedRules?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { learnedRules?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {
    learnedRules: [
      { id: "rule-active", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL", status: "active", confidence: "high" },
      { id: "rule-candidate", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY", status: "candidate", confidence: "low" },
    ],
  });

  assert.ok(seenInput?.learnedRules?.includes("- selector absent → use role+name (E-EXEC-FAIL)"));
  assert.ok(!seenInput?.learnedRules?.includes("flaky wait"), "candidate rules must never reach the reviewer's reject-on-sight list");
  assert.ok(seenInput?.learnedRules?.includes("Each was learned from a real failure and proven by the value oracle or sustained prevention."));
  assert.ok(seenInput?.learnedRules?.includes("Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT."));
});

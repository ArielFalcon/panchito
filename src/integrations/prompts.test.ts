import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPromptAssembled } from "./prompts";
import type { OpencodeRunInput } from "./opencode-client";
import type { QaCase } from "../types";

// RE-1 — the orchestrator's regeneration prompts must NOT command the agent to re-navigate /
// re-snapshot / re-activate serena when authoritative grounding (a Context Pack DOM slice or an
// injected a11y tree) is already in the prompt. They MUST keep commanding exploration when there
// is NO grounding (a blind regen still needs to see the page). "Grounding present" = contextPack
// || domSnapshot.

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: true,
    target: "e2e",
    mode: "diff",
    appName: "testapp",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

const failingCase: QaCase = { name: "owners list", status: "fail", detail: "locator not found" };

// ── fixContent (the motivating bug: a backend-500 failure has no failure DOM, so failureSourced is
//    false, but the Context Pack is still injected — the prompt must not order a re-navigation). ──

test("RE-1 fix-loop: with grounding present and no failure DOM, the fix prompt does NOT command browser_navigate", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], contextPack: "## Context Pack\n\nDOM here" }));
  assert.ok(
    !text.includes("Use browser_navigate + browser_snapshot to see the ACTUAL page"),
    "grounded fix retry must not order a full re-navigation",
  );
  assert.ok(
    text.includes("Fix from the injected grounding"),
    "grounded fix retry must tell the agent to fix from the injected grounding",
  );
});

test("RE-1 fix-loop: with NO grounding, the fix prompt STILL commands browser exploration (blind fix)", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase] }));
  assert.ok(
    text.includes("Use browser_navigate + browser_snapshot to see the ACTUAL page"),
    "a blind fix retry (no pack, no DOM) must still explore the live page",
  );
});

test("RE-1 fix-loop: failureSourced retry keeps the GROUND TRUTH no-navigate framing", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  assert.ok(text.includes("GROUND TRUTH AT FAILURE"), "failure-sourced retry keeps the ground-truth heading");
  assert.ok(
    !text.includes("Use browser_navigate + browser_snapshot to see the ACTUAL page"),
    "failure-sourced retry must not order a re-navigation",
  );
});

// ── reviewContent (reviewer-corrections / static-fix path) ──

test("RE-1 reviewer-corrections: with grounding present, do NOT command re-verify against the live DOM", () => {
  const text = buildPrompt(mkInput({ reviewCorrections: ["scope the selector"], contextPack: "## Context Pack\n\nDOM here" }));
  assert.ok(
    !text.includes("re-verify it against the live DOM with the Playwright MCP"),
    "grounded reviewer-corrections must not order a live-DOM re-verification",
  );
  assert.ok(
    text.includes("Re-verify against the injected grounding"),
    "grounded reviewer-corrections must point at the injected grounding",
  );
});

test("RE-1 reviewer-corrections: with NO grounding, keep the live-DOM re-verify instruction", () => {
  const text = buildPrompt(mkInput({ reviewCorrections: ["scope the selector"] }));
  assert.ok(
    text.includes("re-verify it against the live DOM with the Playwright MCP"),
    "a blind reviewer-corrections turn must still re-verify against the live DOM",
  );
});

// ── workingRules: a DOM snapshot (no pack) is still grounding → suppress the explore-first mandate ──

test("RE-1 working-rules: domSnapshot present without a pack suppresses the explore-first mandate", () => {
  const text = buildPrompt(mkInput({ domSnapshot: "button: Add Owner" }));
  assert.ok(
    !text.includes("MUST use it BEFORE writing any test"),
    "an injected DOM tree must suppress the unconditional explore-first mandate",
  );
  assert.ok(
    text.includes("transcribe selectors from it"),
    "an injected DOM tree must instruct the agent to transcribe from it",
  );
});

test("RE-1 working-rules: no pack AND no DOM keeps the explore-first mandate (blind run)", () => {
  const text = buildPrompt(mkInput());
  assert.ok(
    text.includes("MUST use it BEFORE writing any test"),
    "a fully blind run must keep the explore-first mandate",
  );
});

// ── coverageContent ──

test("RE-1 coverage-enforce: with grounding present, instruct to resolve from grounding, not re-navigate", () => {
  const text = buildPrompt(mkInput({ coverageGap: "src/foo.ts:10-12", contextPack: "## Context Pack\n\nDOM here" }));
  assert.ok(
    text.includes("Resolve any new selectors from the injected grounding"),
    "grounded coverage-enforce must point new selectors at the injected grounding",
  );
});

// ── regen-discipline: a re-generation turn must not re-orient (serena/blast-radius already distilled) ──

test("RE-1 regen-discipline: a re-generation turn suppresses serena re-orientation", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase] }));
  assert.ok(
    text.includes("do NOT re-run find_referencing_symbols"),
    "a regen turn must tell the agent not to re-run the blast-radius analysis",
  );
});

test("RE-1 regen-discipline: a FIRST-PASS (non-regen) turn keeps full orientation", () => {
  const text = buildPrompt(mkInput());
  assert.ok(
    !text.includes("Re-generation turn:"),
    "a first-pass turn must not carry the regen-discipline suppression",
  );
});

// ── Judgment-day fixes (RE-1 efficacy hardening) ──────────────────────────────

// JD-C1: the task's "Scope budget" re-commanded find_referencing_symbols on every diff regen,
// directly contradicting regen-discipline. Gate it on the first pass only.
test("JD-C1: a diff RE-gen prompt does NOT re-command the blast-radius scan (no contradiction)", () => {
  const regen = buildPrompt(mkInput({ fixCases: [failingCase], contextPack: "## Context Pack\n\nDOM" }));
  assert.ok(!regen.includes("Read ONLY the changed symbols"), "regen must not re-command find_referencing_symbols");
  const firstPass = buildPrompt(mkInput());
  assert.ok(firstPass.includes("Read ONLY the changed symbols"), "the first pass keeps the scope budget");
});

// JD-C3: hasInjectedGrounding is a coarse boolean; the grounding may not cover the failing route.
// The agent must be explicitly told to navigate an uncovered route rather than guess blindly.
test("JD-C3: a grounded RE-gen prompt MANDATES navigating a route absent from the grounding (anti-blinding)", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], contextPack: "## Context Pack\n\nDOM" }));
  assert.ok(
    text.includes("you MUST still browser_navigate that specific route"),
    "the agent must navigate an uncovered route, never guess its selectors from incomplete grounding",
  );
});

// JD-S-A4: the serena suppression was absolute; a fix may legitimately need a symbol not in the brief.
test("JD-SA4: regen-discipline carves out reading a symbol the grounding lacks", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase] }));
  assert.ok(
    text.includes("read ONLY that symbol"),
    "the serena suppression must allow reading a symbol absent from the grounding",
  );
});

// JD-C2: regen-discipline was VOLATILE, so it shed before the (TASK-band) command it overrides.
// Moving it to the stable-prefix band makes it render before the volatile context-pack, proving it
// sheds no earlier than the volatile/task content it must outlive.
test("JD-C2: regen-discipline is in the stable band (renders before the volatile context-pack)", () => {
  const a = buildPromptAssembled(mkInput({ fixCases: [failingCase], contextPack: "## CTXPACK-MARKER" }));
  const iRegen = a.text.indexOf("do NOT re-run find_referencing_symbols");
  const iPack = a.text.indexOf("CTXPACK-MARKER");
  assert.ok(iRegen >= 0 && iPack >= 0, "both regen-discipline and the context-pack must be present");
  assert.ok(iRegen < iPack, "regen-discipline (stable) must render before the volatile context-pack");
});

// JD-R2: the failure-sourced fix branch is also grounded (the captured failure tree), so it shares the
// anti-blinding gap — a fix that must touch a route NOT in that tree needs the same escape.
test("JD-R2: the failure-sourced fix branch carries the anti-blinding escape too", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  assert.ok(
    text.includes("you MUST still browser_navigate that specific route"),
    "even a failure-sourced fix must navigate a route absent from the captured failure tree",
  );
});

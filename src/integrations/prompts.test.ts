import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./prompts";
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

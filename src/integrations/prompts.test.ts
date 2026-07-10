import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPromptAssembled, buildPlanPromptAssembled, buildFollowupPrompt, buildWorkerPrompt, buildReviewerPrompt, buildReviewerPromptAssembled, buildExplorerPrompt, buildContextTask } from "./prompts";
import { assemble as caAssemble, section as caSection } from "./context-assembler";
import { roleWindowBytes } from "./model-window-catalog";
import type { OpencodeRunInput } from "./opencode-client";
import type { ParallelWorkerInput, ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
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

// ── Code mode: the task must be source-code-framed (no E2E/page/browser wording) and instruct a
//    compile-before-finish step (the code analogue of e2e's `playwright test --list`). ──
test("code mode task: frames source-code testing, not the e2e flow/page wording", () => {
  const text = buildPrompt(mkInput({ target: "code" }));
  assert.match(text, /UNIT\/INTEGRATION|source-code/i, "code task must be framed as source-code testing");
  assert.doesNotMatch(text, /Generate\/update E2E tests for the flows affected/, "the e2e diff task must not leak into code mode");
});

test("code mode working-rules: instruct compile-before-finish", () => {
  const text = buildPrompt(mkInput({ target: "code" }));
  assert.match(text, /compile-check before finishing/i, "the agent must be told to compile before emitting its verdict");
  assert.match(text, /test-compile|testClasses|go vet|cargo check|tsc --noEmit/, "with the per-ecosystem compile command");
});

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

// RE-3: a re-generation on a CONTINUED session sends a short follow-up — the session already holds
// the working-rules, context-pack, brief and diff, so re-sending them wastes tokens. The follow-up
// carries only the new failure/correction signal + a "do not re-explore" continuation framing.
test("RE-3 buildFollowupPrompt: continuation carries the failures but NOT the full re-sent context", () => {
  const input = mkInput({
    fixCases: [failingCase],
    contextPack: "## Context Pack CTXPACK_UNIQUE_MARKER\n" + "x".repeat(2000),
    domSnapshot: "button: Add Owner",
    failureSourced: true,
  });
  const full = buildPrompt(input);
  const followup = buildFollowupPrompt(input);
  assert.ok(followup.length < full.length, "the follow-up must be smaller than the full prompt");
  assert.ok(followup.includes("owners list"), "the follow-up carries the failing case");
  assert.ok(
    !followup.includes("CTXPACK_UNIQUE_MARKER"),
    "the follow-up must NOT re-send the context pack (the session already has it)",
  );
  assert.ok(
    /continuation|do NOT re-explore|do NOT re-orient|already in this session/i.test(followup),
    "the follow-up frames the turn as a continuation",
  );
});

test("RE-3 buildFollowupPrompt: a failure-sourced continuation still injects the GROUND TRUTH AT FAILURE tree", () => {
  const followup = buildFollowupPrompt(
    mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }),
  );
  assert.ok(followup.includes("GROUND TRUTH AT FAILURE"), "the failure-point tree is NEW info, not in the session yet");
  assert.ok(followup.includes("Add Owner"), "the captured failure DOM is present");
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

// ── WS5.4c: raw DOM embeds must be sanitized like every other model-bound section ──────────────
// domSnapshot is captured live from DEV — the rendered page can legitimately contain a leaked
// secret-shaped string (e.g. an admin panel echoing an API key in a debug banner, or a stray
// data-testid that happens to look like a credential assignment). Every OTHER text section in this
// file (diff, commit message, guidance) is already routed through sanitizeText; the DOM embeds were
// the one inconsistent gap (context-pack.ts's own DOM section has the SAME gap, fixed alongside).
const secretShapedDom = 'button: Submit\ntextbox: apiKey: "sk-liveSECRETVALUE123456"';

test("WS5.4c: the generator's live-DOM section sanitizes a secret-shaped DOM string", () => {
  const text = buildPrompt(mkInput({ domSnapshot: secretShapedDom }));
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "a secret-shaped string in the captured DOM must not reach the model raw");
});

test("WS5.4c: the failure-sourced 'GROUND TRUTH AT FAILURE' DOM section sanitizes a secret-shaped string", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: secretShapedDom, failureSourced: true }));
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "the failure-point DOM capture must be sanitized too");
});

test("WS5.4c: buildFollowupPrompt's injected failure DOM sanitizes a secret-shaped string", () => {
  const followup = buildFollowupPrompt(mkInput({ fixCases: [failingCase], domSnapshot: secretShapedDom, failureSourced: true }));
  assert.ok(!followup.includes("sk-liveSECRETVALUE123456"), "the follow-up's re-injected failure DOM must be sanitized too");
});

test("WS5.4c: buildReviewerPrompt's live-DOM section sanitizes a secret-shaped string", () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    domSnapshot: secretShapedDom,
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(!text.includes("sk-liveSECRETVALUE123456"), "the reviewer's captured DOM must be sanitized too");
});

// ── C1: fix-cases evidence rendering (httpStatus/finalUrl/runtimeErrors) ─────
// The FixLoop already carries runtime evidence on each failing QaCase (A2), but the fix-cases
// prompt sections rendered only `name` + `detail`, discarding the strongest signal available for
// telling an app defect (5xx, console error) apart from a test defect. Both render sites — the
// initial fixContent in buildPromptAssembled/buildPrompt and the RE-3 buildFollowupPrompt — must
// surface it.

const evidenceCase: QaCase = {
  name: "owners list",
  status: "fail",
  detail: "locator not found",
  httpStatus: 503,
  finalUrl: "https://dev.example.com/owners",
  runtimeErrors: [
    { type: "pageerror", text: "TypeError: cannot read properties of undefined" },
    { type: "console.error", text: "Failed to load resource: the server responded with a status of 503" },
  ],
};

test("C1: buildPrompt fix-cases section renders httpStatus for a failing case", () => {
  const text = buildPrompt(mkInput({ fixCases: [evidenceCase] }));
  assert.match(text, /HTTP 503/, "the fix-cases section must surface the correlated HTTP status");
});

test("C1: buildPrompt fix-cases section renders finalUrl for a failing case", () => {
  const text = buildPrompt(mkInput({ fixCases: [evidenceCase] }));
  assert.ok(
    text.includes("https://dev.example.com/owners"),
    "the fix-cases section must surface the page URL at the failure point",
  );
});

test("C1: buildPrompt fix-cases section renders up to 3 runtimeErrors lines", () => {
  const text = buildPrompt(mkInput({ fixCases: [evidenceCase] }));
  assert.match(text, /\[pageerror\] TypeError: cannot read properties of undefined/);
  assert.match(text, /\[console\.error\] Failed to load resource: the server responded with a status of 503/);
});

test("C1: buildPrompt fix-cases section caps runtimeErrors at 3 lines", () => {
  const manyErrors: QaCase = {
    ...evidenceCase,
    runtimeErrors: [
      { type: "pageerror", text: "error one" },
      { type: "pageerror", text: "error two" },
      { type: "pageerror", text: "error three" },
      { type: "pageerror", text: "error four" },
    ],
  };
  const text = buildPrompt(mkInput({ fixCases: [manyErrors] }));
  assert.ok(text.includes("error one") && text.includes("error two") && text.includes("error three"));
  assert.ok(!text.includes("error four"), "runtimeErrors rendering must cap at 3 lines per case");
});

test("C1: buildPrompt fix-cases section slices a long runtimeErrors text to ~200 chars", () => {
  const longText = "X".repeat(500);
  const longErrorCase: QaCase = { ...evidenceCase, runtimeErrors: [{ type: "pageerror", text: longText }] };
  const text = buildPrompt(mkInput({ fixCases: [longErrorCase] }));
  assert.ok(!text.includes("X".repeat(500)), "a long runtimeErrors text must be sliced, not rendered in full");
  assert.ok(text.includes("X".repeat(200)), "the slice must keep roughly the first 200 chars");
});

test("C1: buildPrompt fix-cases section omits evidence lines when absent (no httpStatus/finalUrl/runtimeErrors)", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase] }));
  assert.doesNotMatch(text, /HTTP \d+ at/, "no httpStatus present must render no HTTP line");
});

test("C1: buildFollowupPrompt fix-cases section also renders httpStatus/finalUrl/runtimeErrors", () => {
  const followup = buildFollowupPrompt(mkInput({ fixCases: [evidenceCase] }));
  assert.match(followup, /HTTP 503/);
  assert.ok(followup.includes("https://dev.example.com/owners"));
  assert.match(followup, /\[pageerror\] TypeError: cannot read properties of undefined/);
});

// ── Slice 4: prompt-info-architecture seams a/b/c/d/e ────────────────────────

// Helper: pad a string to a given byte count.
function padTo(s: string, bytes: number): string {
  const current = Buffer.byteLength(s, "utf8");
  if (current >= bytes) return s;
  return s + " ".repeat(bytes - current);
}

// ── Seam e — acceptance-criterion appears BEFORE diff in diff mode ─────────────────────────

// [RED seam a/e] 1.2: in buildPrompt diff mode, criterion must appear before the diff block.
// Currently the diff block appears first in buildTask, so this test is expected to be RED.
test("seam-e: criterion precedes diff block in diff mode (buildPrompt)", () => {
  const text = buildPrompt(mkInput());
  const iCriterion = text.indexOf("commit to this BEFORE writing");
  const iDiff = text.indexOf("```diff");
  assert.ok(iCriterion >= 0, "acceptance criterion must be present");
  assert.ok(iDiff >= 0, "diff fenced block must be present");
  assert.ok(
    iCriterion < iDiff,
    `acceptance-criterion (offset ${iCriterion}) must appear before the diff block (offset ${iDiff})`,
  );
});

// ── Seam a — diff sheds as semi-stable (shedAs:"semi-stable") ────────────────

// [seam a] 1.1: diff section exists as a dedicated section (not embedded in task).
// We verify this via sectionSizes when the diff fits within budget.
// Also asserts that under shed pressure (using assemble directly), diff (shedAs semi-stable, band 2)
// sheds BEFORE task (band 3).
test("seam-a: diff is a dedicated section (shedAs semi-stable) and sheds before task under budget pressure", () => {
  // Part 1: When diff fits within budget, sectionSizes must have a "diff" key separate from "task".
  const result = buildPromptAssembled(mkInput({
    diff: "diff --git a/src/foo.ts\n+export function foo() {}",
  }));
  assert.ok(
    Object.keys(result.sectionSizes).includes("diff"),
    `expected a dedicated "diff" section in sectionSizes; got: ${Object.keys(result.sectionSizes).join(", ")}`,
  );

  // Part 2: diff section (shedAs semi-stable → band 2) sheds BEFORE task (band 3) under tight budget.
  // Use caAssemble to control budget precisely.
  const DIFF_MARKER = "DIFF_SECTION_MARKER";
  const TASK_MARKER = "TASK_SECTION_MARKER";
  const padded = (s: string) => padTo(s, 20_000);
  const budget = 22_000; // fits 1 of 2 sections

  const shedResult = caAssemble([
    caSection("task", "task", padded(TASK_MARKER), { priority: 1 }),
    caSection("diff", "task", padded(DIFF_MARKER), { priority: 2, shedAs: "semi-stable" }),
  ], { budgetBytes: budget });

  // diff (shedAs semi-stable, band 2) sheds before task (band 3) → DIFF_MARKER absent, TASK_MARKER present.
  assert.ok(
    shedResult.text.includes(TASK_MARKER),
    "task section must survive when diff (shedAs semi-stable) is shed under budget pressure",
  );
  assert.ok(
    !shedResult.text.includes(DIFF_MARKER),
    "diff section (shedAs semi-stable, band 2) must shed before task (band 3) under budget pressure",
  );
});

// [seam a] 1.3 (regression guard, STRENGTHENED): critical-recap (context-pack shedAs:critical-recap,
// band 4) outlasts the diff (shedAs:semi-stable, band 2) AND learned-rules (volatile, band 1) under
// real budget enforcement. Shed order: learned-rules (volatile, band 1) → diff (semi-stable, band 2)
// → context-pack (critical-recap, band 4). Budget forces both learned-rules AND diff to shed while
// the pack survives — proving the invariant under enforcement, not just by construction.
test("seam-a + regression: critical-recap context-pack sheds LAST — survives when diff AND learned-rules are shed", () => {
  const PACK_MARKER = "PACK_MARKER_CONTENT";
  const DIFF_MARKER = "DIFF_SECTION_MARKER";
  const LEARNED_MARKER = "LEARNED_RULES_MARKER";

  const padded = (s: string) => padTo(s, 25_000);
  // Budget: fits only 1 of 3 sections (each ~25k, budget 27k).
  // Shed order: learned-rules (volatile, band 1) → diff (shedAs:semi-stable, band 2)
  //             → context-pack (shedAs:critical-recap, band 4).
  // Expected: LEARNED_MARKER shed, DIFF_MARKER shed, PACK_MARKER survives.
  const budget = 27_000;

  const result = caAssemble([
    caSection("context-pack", "volatile", padded(PACK_MARKER), { priority: 0, shedAs: "critical-recap" }),
    caSection("learned-rules", "volatile", padded(LEARNED_MARKER), { priority: 2 }),
    caSection("diff", "task", padded(DIFF_MARKER), { priority: 2, shedAs: "semi-stable" }),
  ], { budgetBytes: budget });

  assert.ok(
    result.text.includes(PACK_MARKER),
    "context-pack (shedAs:critical-recap, band 4) must survive when budget forces shedding of volatile and semi-stable sections",
  );
  assert.ok(
    !result.text.includes(LEARNED_MARKER),
    "learned-rules (volatile, band 1) must be shed first under tight budget",
  );
  assert.ok(
    !result.text.includes(DIFF_MARKER),
    "diff (shedAs:semi-stable, band 2) must be shed before context-pack (band 4) under tight budget",
  );
});

// ── Seam b — existingSpecFiles renders manifest section ───────────────────────

// [RED seam b] 1.4: existingSpecFiles renders as existing-suite-manifest section in diff mode.
test("seam-b: existingSpecFiles renders manifest section in diff mode", () => {
  const text = buildPrompt(mkInput({ existingSpecFiles: ["e2e/flows/login.spec.ts", "e2e/flows/checkout.spec.ts"] }));
  assert.ok(
    text.includes("e2e/flows/login.spec.ts") && text.includes("e2e/flows/checkout.spec.ts"),
    "manifest section must include both spec file paths",
  );
  assert.ok(
    text.includes("existing-suite-manifest"),
    `manifest section heading "existing-suite-manifest" must appear in the prompt`,
  );
});

// [RED seam b] 1.5: empty existingSpecFiles emits no manifest section.
test("seam-b: empty existingSpecFiles produces no manifest section", () => {
  const text = buildPrompt(mkInput({ existingSpecFiles: [] }));
  assert.ok(
    !text.includes("existing-suite-manifest"),
    "empty existingSpecFiles must not render a manifest section",
  );
});

// [RED seam b] 1.6: absent existingSpecFiles emits no manifest section (backward-compat).
test("seam-b: absent existingSpecFiles produces no manifest section (backward-compat)", () => {
  const text = buildPrompt(mkInput());
  assert.ok(
    !text.includes("existing-suite-manifest"),
    "absent existingSpecFiles must not render a manifest section",
  );
});

// ── Seam c — FE↔BE appears ≤2 times when contextPack present ─────────────────

// [RED seam c] 1.7: at most 2 occurrences of "FE↔BE links" when contextPack is present.
test("seam-c: FE↔BE appears at most twice when contextPack is present", () => {
  const contextMap = {
    builtAtSha: "abc1234",
    routes: [{ path: "/checkout", component: "CheckoutComponent" }],
    api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  };
  // The contextPack itself also mentions FE↔BE links.
  const contextPack = "### FE↔BE links (1 of 1 total)\n- Route `/checkout` → `createOrder`";
  const text = buildPrompt(mkInput({ contextMap, contextPack }));
  const count = (text.match(/FE↔BE links/g) ?? []).length;
  assert.ok(
    count <= 2,
    `"FE↔BE links" must appear at most 2 times when contextPack is present; found ${count} occurrences`,
  );
});

// [RED seam c] 1.8 (non-regression): FE↔BE rendered when contextPack absent.
test("seam-c: full FE↔BE rendered when contextPack is absent (non-regression)", () => {
  const contextMap = {
    builtAtSha: "abc1234",
    routes: [{ path: "/checkout", component: "CheckoutComponent" }],
    api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  };
  const text = buildPrompt(mkInput({ contextMap }));
  assert.ok(
    text.includes("FE↔BE links"),
    "FE↔BE links section must appear in arch-map when contextPack is absent",
  );
});

// ── D3: suppress FE↔BE from exploration brief when contextPack is present ─────

// D3-1: when BOTH contextBrief (with feBe) AND contextPack are present, "FE↔BE links"
// must appear at most ONCE in the assembled prompt (from the pack, not the brief).
test("D3: FE↔BE links appear only once when both contextBrief (with feBe) and contextPack are present", () => {
  const contextBrief = {
    builtForSha: "abc1234",
    objective: "test the checkout flow",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
    routes: [{ path: "/checkout", verified: false as const }],
  };
  const contextPack = "### FE↔BE links (1 of 1 total)\n- Route `/checkout` → `createOrder`";
  const text = buildPrompt(mkInput({ contextBrief, contextPack }));
  const count = (text.match(/FE↔BE links/g) ?? []).length;
  assert.equal(
    count,
    1,
    `"FE↔BE links" must appear exactly once when contextPack is present (only from the pack, not the brief); found ${count} occurrences`,
  );
});

// D3-2 (non-regression): when only contextBrief is present (no contextPack), the brief's
// FE↔BE section must still render normally — suppression must NOT apply.
test("D3: FE↔BE links in contextBrief render normally when contextPack is absent", () => {
  const contextBrief = {
    builtForSha: "abc1234",
    objective: "test the checkout flow",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
    routes: [{ path: "/checkout", verified: false as const }],
  };
  const text = buildPrompt(mkInput({ contextBrief }));
  assert.ok(
    text.includes("FE↔BE links"),
    "FE↔BE links section in the brief must render when contextPack is absent",
  );
});

// D3-3: when contextBrief has NO feBe (absent or empty), behavior is unchanged regardless of contextPack.
test("D3: no FE↔BE section in brief when brief.feBe is absent — no change with or without contextPack", () => {
  const contextBrief = {
    builtForSha: "abc1234",
    objective: "test the checkout flow",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount" }],
    // No feBe property
    routes: [{ path: "/checkout", verified: false as const }],
  };
  const contextPack = "### FE↔BE links (1 of 1 total)\n- Route `/checkout` → `createOrder`";
  const text = buildPrompt(mkInput({ contextBrief, contextPack }));
  // Only the pack's FE↔BE appears (brief has no feBe to suppress)
  const count = (text.match(/FE↔BE links/g) ?? []).length;
  assert.equal(count, 1, "when brief has no feBe, only the pack's FE↔BE link must appear");
});

// ── Seam d — learned-rules shed priority ──────────────────────────────────────

// [seam d] 1.9: learned-rules sheds AFTER reviewer-corrections and coverage-gap.
// After seam d, learned-rules priority is p2 in buildPromptAssembled.
// Use caAssemble to verify the shed order invariant directly.
test("seam-d: learned-rules (p2) sheds AFTER reviewer-corrections (p4) and coverage-gap (p5) in shed order", () => {
  // With seam-d priority p2: volatile shed order is coverage-gap(5) → reviewer-corrections(4) →
  // fix-cases(3) → learned-rules(2) → dom(1). So learned-rules (p2) sheds LAST among these.
  // We verify: with a budget that forces shedding of coverage-gap (p5) only, learned-rules and
  // reviewer-corrections both survive; with more shedding, reviewer-corrections (p4) goes before learned-rules.

  const REVIEWER_MARKER = "REVIEWER_CORRECTIONS_MARKER";
  const LEARNED_MARKER = "LEARNED_RULES_MARKER";
  const GAP_MARKER = "COVERAGE_GAP_MARKER";

  const padded = (s: string) => padTo(s, 20_000);
  // Budget: fits 2 of 3 sections. coverage-gap (p5) sheds first (highest number = first to go).
  // After that, reviewer-corrections (p4) sheds next if still over budget.
  // learned-rules (p2) sheds LAST — so with budget=42k, coverage-gap is shed, both others survive.
  const budget = 42_000;

  const result = caAssemble([
    caSection("reviewer-corrections", "volatile", padded(REVIEWER_MARKER), { priority: 4 }),
    caSection("coverage-gap", "volatile", padded(GAP_MARKER), { priority: 5 }),
    caSection("learned-rules", "volatile", padded(LEARNED_MARKER), { priority: 2 }), // seam-d target priority
  ], { budgetBytes: budget });

  // With p2: coverage-gap (p5) sheds first → LEARNED_MARKER and REVIEWER_MARKER both survive.
  assert.ok(
    result.text.includes(LEARNED_MARKER),
    `learned-rules (p2) must survive budget shedding — coverage-gap (p5) should shed first. ` +
    `Actual sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.ok(
    result.text.includes(REVIEWER_MARKER),
    "reviewer-corrections (p4) must survive when only coverage-gap (p5) is shed",
  );
  assert.ok(
    !result.text.includes(GAP_MARKER),
    "coverage-gap (p5) must be shed first under budget pressure",
  );
});

// [seam d] 1.10: plan-lessons (p2 after seam d) survives budget pressure that evicts plan-arch-map (p2, declared first).
// With both at p2 (after seam d), the stable sort orders shed candidates by declaration order:
// plan-arch-map is declared FIRST in the array → shed FIRST. plan-lessons SURVIVES.
test("seam-d: plan-lessons (p2) survives budget pressure when plan-arch-map (p2, declared first) is shed", () => {
  const LESSONS_MARKER = "PLAN_LESSONS_MARKER";
  const ARCH_MAP_MARKER = "PLAN_ARCH_MAP_MARKER";

  const padded = (s: string) => padTo(s, 20_000);
  // Budget: fits 1 of 2 sections. Both at p2 → tied priority, declaration order decides.
  // plan-arch-map declared first → sheds first. plan-lessons survives.
  const budget = 22_000;

  const result = caAssemble([
    caSection("plan-arch-map", "semi-stable", padded(ARCH_MAP_MARKER), { priority: 2 }),
    caSection("plan-lessons", "semi-stable", padded(LESSONS_MARKER), { priority: 2 }), // seam-d target: p2 (tied with arch-map)
  ], { budgetBytes: budget });

  // Both p2 → stable sort keeps declaration order → plan-arch-map sheds first → plan-lessons survives.
  assert.ok(
    result.text.includes(LESSONS_MARKER),
    `plan-lessons (p2) must survive when plan-arch-map (also p2, declared first) sheds first.`,
  );
  assert.ok(
    !result.text.includes(ARCH_MAP_MARKER),
    "plan-arch-map (p2, declared first) must be shed when only 1 section fits",
  );
});

// ── Seam-d PINNING TESTS: pin REAL production priority scalars (FIX 2 regression guard) ──────────

// PINNING: generator path (prompts.ts line ~828). Calls buildPromptAssembled with large
// learnedRules + coverageGap content so the role budget (192k for kimi-k2.7-code) forces shedding.
//
// WS5.2 (full-flow remediation) SUPERSEDES this pinning's original premise: coverage-gap is now
// rendered with shedAs:"critical-recap" (least-shedable — it is the ENTIRE payload of an enforce-
// mode coverage regen, and losing it silently degrades the one-shot regen into a blind repeat of
// the original prompt). So the assertion FLIPS from the pre-WS5.2 state: coverage-gap now SURVIVES
// budget pressure and learned-rules (still p2, unchanged) is the one that sheds instead — proving
// the shedAs promotion actually took effect, not merely that learned-rules kept its own priority.
test("seam-d PINNING (post-WS5.2): coverage-gap (shedAs critical-recap) survives budget pressure that sheds learned-rules (p2)", () => {
  const LEARNED_MARKER = "PINNING_LEARNED_RULES_MARKER";
  const GAP_MARKER = "PINNING_COVERAGE_GAP_MARKER";

  // Each section ~100k bytes. Together ~200k — exceeds the 192k role budget (deepseek-v4-pro:
  // 64k tokens × 0.75 safety × 4 bytes/token = 192k). At least one section must shed.
  // coverage-gap is promoted to the critical-recap shed band (WS5.2) — it no longer competes with
  // learned-rules in the volatile shed band at all, so learned-rules (still volatile p2) sheds first.
  const learnedContent = padTo(LEARNED_MARKER, 100_000);
  const gapContent = padTo(GAP_MARKER, 100_000);

  const result = buildPromptAssembled(mkInput({
    mode: "diff",
    learnedRules: learnedContent,
    coverageGap: gapContent,
  }));

  assert.ok(
    result.text.includes(GAP_MARKER),
    `coverage-gap (shedAs critical-recap, WS5.2) must survive budget pressure — it is the entire payload ` +
    `of its own regen turn. sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.ok(
    !result.text.includes(LEARNED_MARKER),
    `learned-rules (volatile p2, unchanged) is expected to shed here so the budget math actually forces ` +
    `a real choice between the two — otherwise this test would pass trivially if both fit. ` +
    `sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
});

// PINNING: planner path — ALL THREE modes (diff / manual / complete-exhaustive of
// buildPlanPromptAssembled). Asserts plan-lessons SURVIVES when budget pressure forces shedding
// of plan-arch-map (both p2, arch-map declared first → sheds first by stable sort).
// This test FAILS against the pre-FIX-1 state where complete/exhaustive uses `priority: 3`:
//   with p3 > p2, plan-lessons sheds BEFORE plan-arch-map → LESSONS_MARKER absent → RED.
// After FIX-1 (all three paths at p2), plan-lessons (tied p2, declared second) survives.
test("seam-d PINNING: plan-lessons survives in ALL THREE planner paths (diff/manual/complete-exhaustive)", () => {
  const LESSONS_MARKER = "PINNING_PLAN_LESSONS_MARKER";

  // Construct a contextMap that will render to ~20k bytes (MAX_LEN cap in renderArchitectureContext).
  // Supply 200 routes with long component names to saturate the 20k cap.
  const routes = Array.from({ length: 200 }, (_, i) => ({
    path: `/route-${i}`,
    component: `VeryLongComponentNameToFillUpBudget_${i}_${"x".repeat(60)}`,
  }));
  const contextMap = {
    builtAtSha: "abc1234",
    routes,
    api: [] as Array<{ operationId: string; method: string; path: string }>,
    feBe: [] as Array<{ route: string; operationId: string }>,
  };

  // lessons content ~175k — together with contextMapContent (~20k) and fixed sections (~2k),
  // total ~197k exceeds the 192k role budget (kimi-k2.7-code: 64k × 0.75 × 4 = 192k),
  // forcing one semi-stable section to shed.
  // With p3 for plan-lessons: p3 > p2, so plan-lessons sheds first → LESSONS_MARKER absent → FAIL.
  // With p2 for plan-lessons (all three paths): tied with arch-map (p2, declared first) →
  // arch-map sheds first by declaration order → plan-lessons survives → PASS.
  const largeLearnedRules = padTo(LESSONS_MARKER, 175_000);

  const baseInput = mkInput({ learnedRules: largeLearnedRules, contextMap });

  // Path 1: diff mode
  const diffResult = buildPlanPromptAssembled({ ...baseInput, mode: "diff" });
  assert.ok(
    diffResult.text.includes(LESSONS_MARKER),
    `plan-lessons (p2) must survive in diff planner path. ` +
    `sectionSizes: ${JSON.stringify(diffResult.sectionSizes)}`,
  );

  // Path 2: manual mode
  const manualResult = buildPlanPromptAssembled({ ...baseInput, mode: "manual", guidance: "test the login flow" });
  assert.ok(
    manualResult.text.includes(LESSONS_MARKER),
    `plan-lessons (p2) must survive in manual planner path. ` +
    `sectionSizes: ${JSON.stringify(manualResult.sectionSizes)}`,
  );

  // Path 3: complete mode (the previously missed path — this assertion catches the pre-FIX-1 bug)
  const completeResult = buildPlanPromptAssembled({ ...baseInput, mode: "complete" });
  assert.ok(
    completeResult.text.includes(LESSONS_MARKER),
    `plan-lessons (p2) must survive in complete/exhaustive planner path. ` +
    `If this fails, prompts.ts line ~393 still has priority: 3 (pre-FIX-1). ` +
    `sectionSizes: ${JSON.stringify(completeResult.sectionSizes)}`,
  );
});

// ── A3: selector-priority rule in the STABLE band ────────────────────────────────────────────────
//
// Goal: the selector-priority guidance (prefer getByTestId > getByRole > getByLabel/getByText >
// scoped locator) must appear in the STABLE band of the generated prompt so it fires even when
// DOM capture failed (i.e. when no domSnapshot is present). The rule must be present REGARDLESS
// of whether a domSnapshot is included.
//
// Idempotency: when a domSnapshot IS present, the rule should appear exactly once in the stable
// band (not duplicated in the DOM snapshot section, which already carries its own selector guidance).
//
// These tests are RED until A3 is implemented (the stable-band rule does not exist yet).

// A3-1: selector-priority rule is present in the prompt when NO domSnapshot is injected.
// Currently the priority guidance only lives in the volatile DOM snapshot section, so this FAILS.
test("A3: selector-priority rule is present in the stable band even when no domSnapshot is injected", () => {
  // No domSnapshot → the volatile DOM section is empty; the stable rule must still appear.
  const text = buildPrompt(mkInput({ domSnapshot: undefined }));
  // The stable rule must mention the priority order: getByTestId > getByRole > getByLabel/getByText
  assert.ok(
    /getByTestId.*getByRole|getByRole.*getByLabel|selector.*priority|priority.*selector/i.test(text),
    "the stable band must include a selector-priority rule even when no domSnapshot is present",
  );
});

// A3-2: selector-priority rule is present in the prompt when a domSnapshot IS injected.
// The rule must appear in the stable band (fired regardless), and the DOM snapshot section
// may also carry its own guidance — but neither should be absent when the other is present.
test("A3: selector-priority rule is present in the stable band when a domSnapshot IS injected", () => {
  const text = buildPrompt(mkInput({ domSnapshot: "button: Add Owner" }));
  assert.ok(
    /getByTestId.*getByRole|getByRole.*getByLabel|selector.*priority|priority.*selector/i.test(text),
    "the stable band must include a selector-priority rule even when a domSnapshot is present",
  );
});

// A3-3: the stable-band selector-priority rule does NOT duplicate the DOM snapshot section's guidance.
// When a domSnapshot is present, the priority mention in the stable band must be present but
// the full DOM grounding section is separate. We check there is no exact verbatim duplication of
// the stable rule. (Idempotency guard.)
test("A3: selector-priority rule appears no more than twice across the prompt (idempotency guard)", () => {
  // With both domSnapshot and grounding, the rule may appear in the stable band AND in the
  // volatile grounding section. It must NOT be duplicated beyond those two natural occurrences.
  const text = buildPrompt(mkInput({ domSnapshot: "button: Add Owner" }));
  // Count occurrences of "Selector priority" (case-insensitive) — must be ≤ 2
  const STABLE_RULE_MARKER = "Selector priority";
  const matches = (text.match(new RegExp(STABLE_RULE_MARKER, "gi")) ?? []).length;
  assert.ok(
    matches <= 2,
    `selector-priority rule must appear at most twice across the prompt (stable + volatile); found ${matches}`,
  );
});

// ── C1: diff archetypes surfaced to the generator as a one-line hint ──────────

// C1-1: when diffArchetypes are present in the input, the prompt must contain
// the one-line "Change shape (deterministic):" hint.
test("C1: diffArchetypes line appears in the prompt when archetypes are present", () => {
  const text = buildPrompt(mkInput({ diffArchetypes: ["auth-flow", "data-list"] }));
  assert.ok(
    text.includes("Change shape (deterministic)"),
    "prompt must contain the 'Change shape (deterministic):' hint when diffArchetypes are present",
  );
  assert.ok(
    text.includes("auth-flow"),
    "prompt must include the archetype kinds",
  );
  assert.ok(
    text.includes("data-list"),
    "prompt must include all archetype kinds",
  );
});

// C1-2: when diffArchetypes are absent, NO empty header must appear.
test("C1: no diffArchetypes line when archetypes are absent", () => {
  const text = buildPrompt(mkInput());
  assert.ok(
    !text.includes("Change shape (deterministic)"),
    "prompt must NOT contain the archetypes hint when diffArchetypes is absent",
  );
});

// C1-3: when diffArchetypes is an empty array, NO empty header must appear.
test("C1: no diffArchetypes line when archetypes array is empty", () => {
  const text = buildPrompt(mkInput({ diffArchetypes: [] }));
  assert.ok(
    !text.includes("Change shape (deterministic)"),
    "prompt must NOT contain the archetypes hint when diffArchetypes is an empty array",
  );
});

// ── sdd/migration-wiring-phase-2 Slice 4 (D-E skill-exemplar restore) ────────────────────────────
// matchExemplars/renderExemplarsForPrompt (src/qa/learning/skill-exemplar.ts) run during prompt
// assembly, keyed off input.structuralPatterns (a StructuralPattern[], NOT a single pattern —
// matchExemplars itself takes ONE pattern, so the consumer here loops + flatMaps + dedupes before
// rendering). Wired into buildPromptAssembled alongside the existing diffArchetypes path (same
// semi-stable/priority-3 band), byte-budget capped at ~1.5KB like other capped sections.

test("Slice 4: a matched structural pattern (form+validation) includes its exemplar template in the prompt", () => {
  const text = buildPrompt(mkInput({
    structuralPatterns: [{ kind: "form", hasOnSubmit: true, hasValidation: true }],
  }));
  assert.ok(
    text.includes("## Skill exemplars for the detected structural patterns"),
    "prompt must contain the Skill exemplars section heading when a pattern matches",
  );
  assert.ok(
    text.includes("Form invalid input"),
    "prompt must include the matched exemplar's name/heading",
  );
  assert.ok(
    text.includes("asserts that the error message is visible and the form was NOT submitted successfully"),
    "prompt must include the matched exemplar's own template text",
  );
});

test("Slice 4: no matching structural pattern (generic) omits the Skill exemplars section entirely", () => {
  const text = buildPrompt(mkInput({ structuralPatterns: [{ kind: "generic" }] }));
  assert.ok(
    !text.includes("## Skill exemplars for the detected structural patterns"),
    "prompt must NOT contain the Skill exemplars heading when no pattern matches the catalog",
  );
});

test("Slice 4: structuralPatterns absent omits the Skill exemplars section (never fabricated)", () => {
  const text = buildPrompt(mkInput());
  assert.ok(
    !text.includes("## Skill exemplars for the detected structural patterns"),
    "prompt must NOT contain the Skill exemplars heading when structuralPatterns is absent",
  );
});

test("Slice 4: an empty structuralPatterns array omits the Skill exemplars section", () => {
  const text = buildPrompt(mkInput({ structuralPatterns: [] }));
  assert.ok(
    !text.includes("## Skill exemplars for the detected structural patterns"),
    "prompt must NOT contain the Skill exemplars heading when structuralPatterns is an empty array",
  );
});

test("Slice 4: matched exemplars whose rendered content exceeds the ~1.5KB budget are omitted entirely (overflow:drop, no window starvation)", () => {
  // Every BUILT_IN_EXEMPLARS entry matches — 6 exemplars, ~1.7KB rendered (measured), over the 1536
  // byte cap. The whole section must drop rather than silently truncating mid-template or starving
  // other sections' budget.
  const text = buildPrompt(mkInput({
    structuralPatterns: [
      { kind: "form", hasOnSubmit: true, hasValidation: true },
      { kind: "form", hasOnSubmit: true, hasValidation: false },
      { kind: "api-call", method: "POST", hasRequestBody: true, hasErrorHandling: true },
      { kind: "stateful-cache", sourceType: "any", hasIndependentWritePath: true },
      { kind: "data-list", hasFilter: false, hasPagination: false, hasEmptyState: true },
    ],
  }));
  assert.ok(
    !text.includes("## Skill exemplars for the detected structural patterns"),
    "an over-budget skill-exemplars section must be omitted entirely, not truncated mid-template",
  );
});

test("Slice 4: duplicate exemplar matches across multiple patterns are deduped by name (never rendered twice)", () => {
  // Two data-list-shaped patterns both match BOTH data-list exemplars (matchExemplars' own
  // kind==='data-list' branch returns true unconditionally) — without dedup this would render
  // "Data list empty state" twice.
  const text = buildPrompt(mkInput({
    structuralPatterns: [
      { kind: "data-list", hasFilter: false, hasPagination: false, hasEmptyState: true },
      { kind: "data-list", hasFilter: true, hasPagination: true, hasEmptyState: false },
    ],
  }));
  const occurrences = (text.match(/### Data list empty state/g) ?? []).length;
  assert.equal(occurrences, 1, "a duplicate exemplar match across patterns must render exactly once, never duplicated");
});

// ── sdd/migration-wiring-phase-2 apply-batch-3 rider (orchestrator-directed) ──────────────────────
// Slice 4 wired structuralPatterns[] end-to-end but nothing on the live path ever populated it
// (verified: zero references in run-qa.use-case.ts, generation-port.adapter.ts,
// rewritten-engine-factory.ts) — the "archetype-matched templates re-enter the generation prompt"
// scenario went unmet for a real run. Fixed by deriving structuralPatterns from input.diff (the SAME
// diff cappedDiffText already reads) when the caller supplies none — no new qa-engine plumbing.

test("rider: a diff matching a structural archetype re-enters the generation prompt (structuralPatterns derived from the diff, never explicitly supplied)", () => {
  const text = buildPrompt(mkInput({
    diff: [
      "diff --git a/src/api.ts b/src/api.ts",
      "+export async function submitOrder(payload: OrderPayload) {",
      "+  try {",
      '+    const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });',
      '+    if (!res.ok) throw new Error("failed");',
      "+    return res.json();",
      "+  } catch (error) {",
      "+    console.error(error);",
      "+  }",
      "+}",
    ].join("\n"),
  }));
  assert.ok(
    text.includes("## Skill exemplars for the detected structural patterns"),
    "a diff matching the api-call archetype must derive structuralPatterns and render the exemplar section, even though structuralPatterns was never supplied",
  );
  assert.ok(
    text.includes("API error handling"),
    "the derived pattern must match the same catalog entry an explicitly-supplied pattern would",
  );
});

test("rider: a shape-less diff derives only the generic pattern — no exemplar section (never fabricated)", () => {
  // mkInput()'s default diff ("export function foo() {}") matches no archetype.
  const text = buildPrompt(mkInput());
  assert.ok(
    !text.includes("## Skill exemplars for the detected structural patterns"),
    "a diff matching no archetype must derive only the generic pattern, which matches no exemplar",
  );
});

test("rider: an explicitly-supplied structuralPatterns still wins over derivation from the diff", () => {
  // The diff here would derive an api-call pattern if it were consulted; the explicit
  // structuralPatterns (form) must win instead — proves the derivation is a FALLBACK, not an override.
  const text = buildPrompt(mkInput({
    diff: 'diff --git a/src/api.ts b/src/api.ts\n+fetch("/x", { body: x, method: "POST" });\n try { } catch (error) {}\n',
    structuralPatterns: [{ kind: "form", hasOnSubmit: true, hasValidation: true }],
  }));
  assert.ok(text.includes("Form invalid input"), "an explicitly-supplied structuralPatterns must take precedence over diff-derived ones");
  assert.ok(!text.includes("API error handling"), "the diff-derived api-call pattern must NOT also render when structuralPatterns was explicitly supplied");
});

// ── sdd/migration-wiring-phase-2 Slice 6b (diff→model egress boundary) ────────────────────────────
// cappedDiffText — THE single way every prompt embeds a commit diff — now sanitizes in "model" mode
// (previously "issue" mode, silently defeating WS5.4a's own stated intent for the diff itself) and
// runs the post-redaction fail-loud guard (assertNoSecretLeak) immediately after.

test("Slice 6b (mode fix): the diff embedded in the generator prompt uses 'model' mode — an auth-shaped type annotation is NOT over-redacted", () => {
  const text = buildPrompt(mkInput({
    diff: "diff --git a/src/server/auth.ts b/src/server/auth.ts\n+function sign(data: string, secret: string): string {\n",
  }));
  assert.ok(
    text.includes("secret: string"),
    "model-mode sanitization must leave an ordinary type annotation intact in the diff sent to the model (WS5.4a's own stated intent, previously unwired for the diff itself)",
  );
});

test("Slice 6b.1: a diff with a genuine secret is fully redacted before reaching the generator prompt — never sent raw", () => {
  const text = buildPrompt(mkInput({
    diff: 'diff --git a/src/config.ts b/src/config.ts\n+const apiKey = "sk-live-abc123XYZsecretvalue";\n',
  }));
  assert.ok(!text.includes("sk-live-abc123XYZsecretvalue"), "a real secret must never reach the model unredacted, even in model mode");
  assert.match(text, /\[REDACTED\]/, "the redaction marker must appear in its place");
});

test("Slice 6b.4: an auth.ts-shaped diff never trips the diff→model guard (false-positive tolerance, never throws)", () => {
  assert.doesNotThrow(() => buildPrompt(mkInput({
    diff: [
      "diff --git a/src/server/auth.ts b/src/server/auth.ts",
      "+function sign(data: string, secret: string): string {",
      "+export function issueSession(username: string, secret: string, ttlSeconds: number, now = Date.now()): string {",
      "+export function validateSession(token: string, secret: string, now = Date.now()): string | null {",
    ].join("\n"),
  })));
});

// 6b.2 ("a secret survives redaction at diff→model → SecretLeakError thrown") is covered at the unit
// level in src/orchestrator/sanitizer.test.ts (assertNoSecretLeak's own dedicated tests) rather than
// as an end-to-end prompts.ts fixture: sanitizeText and containsSecrets share ONE pattern table with
// identical skip/modelSkip logic, so a secret genuinely surviving redaction is not constructible
// through this real pipeline today (by design — the guard exists as an invariant check against a
// FUTURE regression, e.g. a pattern added to one function but not the other). cappedDiffText's own
// wiring (`assertNoSecretLeak(redacted, "model", "diff→model")`, immediately after sanitizeText) is
// the reviewable proof the guard is actually in the diff→model path.

// ── C2: static-signal rendered in CODE-MODE prompts ──────────────────────────

// C2-1: a code-mode generation input WITH staticSignal renders the static-signal section.
test("C2: code-mode with staticSignal renders the static-signal section", () => {
  const text = buildPrompt(mkInput({ target: "code", staticSignal: "## Static signal\n\nsymbol: Foo.bar" }));
  assert.ok(
    text.includes("Static signal") && text.includes("Foo.bar"),
    "code-mode prompt with staticSignal must include the static-signal section",
  );
});

// C2-2: a code-mode generation input WITHOUT staticSignal must NOT add an empty section.
test("C2: code-mode without staticSignal emits no static-signal section", () => {
  const text = buildPrompt(mkInput({ target: "code" }));
  assert.ok(
    !text.includes("Static signal"),
    "code-mode prompt without staticSignal must NOT include an empty static-signal section",
  );
});

// C2-3 (regression): the e2e path must be byte-identical when nothing changes — staticSignal present
// must still render in e2e mode (non-regression).
test("C2 regression: e2e-mode with staticSignal still renders static-signal section", () => {
  const text = buildPrompt(mkInput({ target: "e2e", staticSignal: "## Static signal\n\nsymbol: Foo.bar" }));
  assert.ok(
    text.includes("Static signal") && text.includes("Foo.bar"),
    "e2e-mode prompt with staticSignal must include the static-signal section (regression guard)",
  );
});

// ── Stitcher→Generation seam (design §3.4, S2.4): "Cross-service links (deterministic)" section ──

const link1 = {
  from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
  to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
  transport: "http" as const,
  contractRef: "GET /orders/{id}",
  confidence: 0.9,
  source: "openapi",
};
const drift1 = {
  from: { repo: "org/front", file: "src/api.ts", symbol: "deleteOrder" },
  verb: "DELETE",
  path: "/orders/{id}",
};

test("S2.4(1): non-empty serviceLinks in generation mode renders a 'Cross-service links (deterministic' section with from -> to (transport, confidence)", () => {
  const text = buildPrompt(mkInput({ serviceLinks: [link1] }));
  assert.match(text, /Cross-service links \(deterministic/, "must render the section header");
  assert.match(
    text,
    /org\/front\/src\/api\.ts#getOrder.*->.*org\/orders.*GET \/orders\/\{id\}.*http, confidence 0\.90/,
    "must render the from -> to (transport, confidence) line format",
  );
});

test("S2.4(2): contractDrift alongside links renders under a DISTINCT 'Contract drift (WARNINGS' sub-heading, never merged into the link list", () => {
  const text = buildPrompt(mkInput({ serviceLinks: [link1], contractDrift: [drift1] }));
  assert.match(text, /Contract drift \(WARNINGS/, "must render the drift sub-heading");
  assert.match(text, /DELETE \/orders\/\{id\}/, "must render the drift verb+path");
  const linksIdx = text.indexOf("Cross-service links");
  const driftIdx = text.indexOf("Contract drift");
  assert.ok(linksIdx >= 0 && driftIdx > linksIdx, "drift sub-heading must come AFTER the links list, not merged into it");
});

test("S2.4(3): absent/empty serviceLinks renders NO section at all — byte-identical to a prompt assembled without the field", () => {
  const withEmpty = buildPrompt(mkInput({ serviceLinks: [] }));
  const withoutField = buildPrompt(mkInput({}));
  assert.ok(!withEmpty.includes("Cross-service links"), "empty serviceLinks must render no section");
  assert.equal(withEmpty, withoutField, "an empty array must be byte-identical to the field being entirely absent");
});

test("S2.4(4): isGenerationMode false (context mode) suppresses the section even when serviceLinks is present", () => {
  const text = buildPrompt(mkInput({ mode: "context", serviceLinks: [link1] }));
  assert.ok(!text.includes("Cross-service links"), "context mode must never render the service-links section, mirroring every other isGenerationMode-gated section");
});

test("S2.4(5): more than MAX_LINKS (40) links renders only the first 40; more than MAX_DRIFT (20) drift entries renders only the first 20", () => {
  const manyLinks = Array.from({ length: 45 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const manyDrift = Array.from({ length: 25 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    verb: "GET",
    path: `/path${i}`,
  }));
  const text = buildPrompt(mkInput({ serviceLinks: manyLinks, contractDrift: manyDrift }));
  assert.ok(text.includes("sym0") && text.includes("sym39"), "the first 40 links must render");
  assert.ok(!text.includes("sym40") && !text.includes("sym44"), "links beyond the 40-cap must be dropped");
  assert.ok(text.includes("/path0") && text.includes("/path19"), "the first 20 drift entries must render");
  assert.ok(!text.includes("/path20") && !text.includes("/path24"), "drift entries beyond the 20-cap must be dropped");
});

// WS5.5(a): unimpacted service links beyond MAX_LINKS were silently dropped with no trace — the
// generator (and any human reading a captured prompt) had no way to know MORE links existed past the
// cut. Append an observability marker naming how many were omitted.
test("WS5.5a: more than MAX_LINKS (40) links appends a '...and N more links' marker (single-agent prompt)", () => {
  const manyLinks = Array.from({ length: 45 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const text = buildPrompt(mkInput({ serviceLinks: manyLinks }));
  assert.match(text, /\.\.\.and 5 more links?/i, "45 links - 40 rendered = 5 must be named in the marker");
});

test("WS5.5a: exactly MAX_LINKS (40) links does NOT append the marker (nothing was actually omitted)", () => {
  const exactLinks = Array.from({ length: 40 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const text = buildPrompt(mkInput({ serviceLinks: exactLinks }));
  assert.doesNotMatch(text, /\.\.\.and \d+ more links?/i, "no marker when every link was actually rendered");
});

test("WS5.5a: more than MAX_LINKS (40) links appends the '...and N more links' marker in the worker prompt too", () => {
  const manyLinks = Array.from({ length: 42 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const text = buildWorkerPrompt(mkWorkerInput({ serviceLinks: manyLinks }));
  assert.match(text, /\.\.\.and 2 more links?/i, "42 links - 40 rendered = 2 must be named in the worker prompt marker too");
});

test("S2.4(7): contractDrift present with serviceLinks ABSENT/empty still renders the section header and the drift WARNING (pure-drift scenario)", () => {
  const withoutLinks = buildPrompt(mkInput({ contractDrift: [drift1] }));
  assert.match(withoutLinks, /Cross-service links \(deterministic/, "must still render the section header when drift-only");
  assert.match(withoutLinks, /Contract drift \(WARNINGS/, "must render the drift sub-heading");
  assert.match(withoutLinks, /DELETE \/orders\/\{id\}/, "must render the drift verb+path");

  const withEmptyLinks = buildPrompt(mkInput({ serviceLinks: [], contractDrift: [drift1] }));
  assert.match(withEmptyLinks, /Contract drift \(WARNINGS/, "empty serviceLinks array + drift must still render drift");

  assert.ok(
    !/-.*->.*\(http|grpc|event/.test(withoutLinks.split("Contract drift")[0] ?? ""),
    "the links sub-list itself must not render an empty/placeholder entry when serviceLinks is absent",
  );
});

test("S2.4(8): links-only (no drift) still renders exactly as before — no empty 'Contract drift' heading", () => {
  const text = buildPrompt(mkInput({ serviceLinks: [link1] }));
  assert.ok(!text.includes("Contract drift"), "links-only must not render a drift heading at all");
});

test("S2.4(6): serviceLinks string fields pass through the local s() sanitize wrapper (secrets redacted, never passed through raw)", () => {
  const dirtyLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "const k = sk-abc123XYZsecretvalue" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildPrompt(mkInput({ serviceLinks: [dirtyLink] }));
  assert.ok(!text.includes("sk-abc123XYZsecretvalue"), "a secret-shaped string in a serviceLinks field must be redacted by the sanitize wrapper, never passed through raw");
  assert.match(text, /REDACTED/, "the sanitize wrapper must have actually redacted the secret pattern");
});

// ── Slice C (structural-signals-expansion, design §3.6/C-R6): inline "[IMPACTED:<tier>]" markers on
// the EXISTING "Cross-service links" section bullets — NOT a new/duplicate subsection. Byte-identical
// when crossRepoImpact is absent (empty lookup, tierFor always undefined, prefix always ""). ────────

test("C-R6(1): a matched link's EXISTING bullet gets the '[IMPACTED:<tier>]' prefix", () => {
  const text = buildPrompt(mkInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.match(text, /\[IMPACTED:contract-file\]/, "the matched link's bullet must carry the inline tier marker");
  assert.match(
    text,
    /\[IMPACTED:contract-file\] `org\/front\/src\/api\.ts#getOrder`/,
    "the marker must prefix the SAME existing bullet line, not a separate entry",
  );
});

test("C-R6(2): no duplicate '### Impacted by this change' (or similarly named) subsection is ever rendered", () => {
  const text = buildPrompt(mkInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.ok(!/impacted by this change/i.test(text), "no separate 'Impacted by this change' subsection must ever be rendered — the design corrects an earlier duplicate-subsection revision");
  // The existing "Cross-service links" section header must still appear exactly once.
  const occurrences = text.split("Cross-service links").length - 1;
  assert.equal(occurrences, 1, "the Cross-service links section header must render exactly once, never duplicated for the impacted subset");
});

test("C-R6(3): an empty crossRepoImpact.impactedLinks is byte-identical to the field being entirely absent", () => {
  const withEmpty = buildPrompt(mkInput({ serviceLinks: [link1], crossRepoImpact: { impactedLinks: [] } }));
  const withoutField = buildPrompt(mkInput({ serviceLinks: [link1] }));
  assert.equal(withEmpty, withoutField, "an empty impacted set must render byte-identical to the field being entirely absent");
  assert.ok(!withoutField.includes("[IMPACTED:"), "no inline marker may render when crossRepoImpact is absent");
});

test("C-R6(4): a link present in serviceLinks but NOT in crossRepoImpact.impactedLinks renders with NO marker prefix", () => {
  const unmatchedLink = {
    from: { repo: "org/front", file: "src/other.ts", symbol: "getOther" },
    to: { repo: "org/other", file: "src/routes.ts", symbol: "GET /other" },
    transport: "http" as const,
    contractRef: "GET /other",
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildPrompt(mkInput({
    serviceLinks: [link1, unmatchedLink],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "impacted-symbol" }] },
  }));
  assert.match(text, /\[IMPACTED:impacted-symbol\] `org\/front\/src\/api\.ts#getOrder`/, "the matched link must carry the marker");
  assert.doesNotMatch(
    text.split("\n").find((l) => l.includes("getOther")) ?? "",
    /\[IMPACTED:/,
    "an unmatched link's bullet must render with NO [IMPACTED:...] prefix",
  );
});

test("C-R6(5): an impacted link past the MAX_LINKS cut still renders WITH its marker — impacted links survive truncation", () => {
  const filler = Array.from({ length: 44 }, (_, i) => ({
    from: { repo: "org/front", file: `src/f${i}.ts`, symbol: `call${i}` },
    to: { repo: "org/other", file: "src/routes.ts", symbol: `GET /f${i}` },
    transport: "http" as const,
    contractRef: `GET /f${i}`,
    confidence: 0.9,
    source: "openapi",
  }));
  const text = buildPrompt(mkInput({
    serviceLinks: [...filler, link1], // the impacted link sits at index 44 — past the 40-link ceiling
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.match(
    text,
    /\[IMPACTED:contract-file\] `org\/front\/src\/api\.ts#getOrder`/,
    "the impacted link must survive the MAX_LINKS truncation with its marker — discovery order must not silently drop the one annotated link",
  );
});

// ── Audit C4a — two prompt defects (docs/superpowers/plans/2026-07-02-qa-engine-audit-remediation.md) ──
//
// Defect 1: buildAttrHint (qa-engine dom-snapshot.ts / legacy src/qa/dom-snapshot.ts) emits a
// `-> [attr]` hint for id=/name=/href/type= too, not just test-id. The selector-priority rule
// wrongly instructs getByTestId for ANY `-> [attr]` hint, which cannot resolve for a non-test-id
// hint. The rule must name the discriminator: the hint text must start with the configured
// testIdAttribute name (e.g. "data-testid=") — NOT just "carries a hint".

function mkWorkerInput(overrides: Partial<ParallelWorkerInput> = {}): ParallelWorkerInput {
  return {
    objective: "verify the owner list renders",
    flow: "owners list",
    symbols: ["OwnerListComponent"],
    needsUi: true,
    specFile: "flows/owners-list.spec.ts",
    repo: "org/app",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    appName: "testapp",
    mode: "diff",
    ...overrides,
  };
}

test("C4a defect 1: worker selector-priority rule names the test-id-attribute-name discriminator, not just 'carries a hint'", () => {
  const text = buildWorkerPrompt(mkWorkerInput({ domSnapshot: "button: Add Owner -> [data-testid=add-owner]" }));
  const rule = /Selector priority:[^\n]*/.exec(text)?.[0] ?? "";
  assert.ok(rule.length > 0, "worker prompt must contain a Selector priority rule");
  // The old wording ("carries a ... hint") is ambiguous about id=/name=/href hints. The fixed
  // wording must name the discriminator concretely: the hint must START WITH the testIdAttribute
  // name (e.g. "data-testid=") — not merely "a hint is present".
  assert.ok(
    /starts with|begins with|testIdAttribute name|the configured test-id attribute/i.test(rule),
    `worker selector-priority rule must name the test-id-only discriminator concretely; got: ${rule}`,
  );
  assert.doesNotMatch(
    rule,
    /carries a (trailing )?`?-> \[attr\]`? hint\b(?!.*test-id)/i,
    "worker rule must not instruct getByTestId for ANY hint — only test-id hints",
  );
});

test("C4a defect 1: stable-band selector-priority rule names the test-id-attribute-name discriminator, not just 'carries a hint'", () => {
  const text = buildPrompt(mkInput({ domSnapshot: undefined }));
  const rule = /Selector priority:[^\n]*/.exec(text)?.[0] ?? "";
  assert.ok(rule.length > 0, "stable band must contain a Selector priority rule");
  assert.ok(
    /starts with|begins with|testIdAttribute name|the configured test-id attribute/i.test(rule),
    `stable-band selector-priority rule must name the test-id-only discriminator concretely; got: ${rule}`,
  );
});

test("C4a defect 1: DOM-snapshot section guidance also names the test-id-only discriminator (not 'any hint')", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: false }));
  // The volatile "Live DEV accessibility tree" section explains the `-> [attr]` hint; it must not
  // claim ANY hint implies a test-id — it must name the discriminator (attribute-name prefix).
  const domSection = text.slice(text.indexOf("Live DEV accessibility tree"));
  assert.ok(
    /starts with|begins with|testIdAttribute name|the configured test-id attribute/i.test(domSection),
    "DOM-snapshot section must name the test-id-only discriminator concretely",
  );
});

// Defect 2: the GROUND-TRUTH-AT-FAILURE quote-then-assert block currently offers a CSS/data-testid
// fallback for an unquotable locator — a fabrication license (Pillar 3 forbids inventing
// data-testid/CSS values not present in any grounding). The ONLY permitted fallback is getByText
// quoted from the failure tree.
test("C4a defect 2: GROUND-TRUTH-AT-FAILURE fallback offers getByText only, not CSS/data-testid", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase], domSnapshot: "button: Add Owner", failureSourced: true }));
  const block = text.slice(text.indexOf("GROUND TRUTH AT FAILURE"), text.indexOf("GROUND TRUTH AT FAILURE") + 1500);
  assert.ok(block.includes("getByText"), "the fallback must still offer getByText");
  assert.doesNotMatch(
    block,
    /CSS\/data-testid|data-testid locator|scoped CSS\/data-testid/i,
    "the fallback must NOT offer a CSS/data-testid locator — that invites fabricating an unverified value",
  );
});

// ── Slice A (structural-signals-expansion): worker-prompt "Cross-service links" section ──
// Mirrors the single-agent S2.4 discipline exactly (local s() sanitizer, MAX_LINKS/MAX_DRIFT caps,
// (hasLinks||hasDrift)-gated content) but with NO isGenerationMode gate — the worker builder has no
// such mode switch (workers always generate).

test("A-R3(1): worker prompt with populated serviceLinks renders the 'Cross-service links' section with from -> to (transport, confidence)", () => {
  const text = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [link1] }));
  assert.match(text, /Cross-service links \(deterministic/, "worker prompt must render the section header when serviceLinks is populated");
  assert.match(
    text,
    /org\/front\/src\/api\.ts#getOrder.*->.*org\/orders.*GET \/orders\/\{id\}.*http, confidence 0\.90/,
    "worker prompt must render the from -> to (transport, confidence) line format",
  );
});

// ── A-R3/C-R6 (worker counterpart): the worker-prompt "Cross-service links" section gains the SAME
// inline "[IMPACTED:<tier>] markers on matched bullets — NOT a new/duplicate subsection, the same
// impacted-first-before-MAX_LINKS ordering from 62b6bb4, and the same byte-identical-when-absent
// guarantee — mirroring the single-agent C-R6 family exactly, now on ParallelWorkerInput. ────────

test("A-R3-C-R6(1): a matched link's EXISTING bullet gets the '[IMPACTED:<tier>]' prefix in the worker prompt", () => {
  const text = buildWorkerPrompt(mkWorkerInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.match(text, /\[IMPACTED:contract-file\]/, "the matched link's bullet must carry the inline tier marker");
  assert.match(
    text,
    /\[IMPACTED:contract-file\] `org\/front\/src\/api\.ts#getOrder`/,
    "the marker must prefix the SAME existing bullet line, not a separate entry",
  );
});

test("A-R3-C-R6(2): no duplicate '### Impacted by this change' (or similarly named) subsection is ever rendered in the worker prompt", () => {
  const text = buildWorkerPrompt(mkWorkerInput({
    serviceLinks: [link1],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.ok(!/impacted by this change/i.test(text), "no separate 'Impacted by this change' subsection must ever be rendered in the worker prompt");
  const occurrences = text.split("Cross-service links").length - 1;
  assert.equal(occurrences, 1, "the Cross-service links section header must render exactly once in the worker prompt, never duplicated for the impacted subset");
});

test("A-R3-C-R6(3): an empty crossRepoImpact.impactedLinks is byte-identical to the field being entirely absent in the worker prompt", () => {
  const withEmpty = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [link1], crossRepoImpact: { impactedLinks: [] } }));
  const withoutField = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [link1] }));
  assert.equal(withEmpty, withoutField, "an empty impacted set must render byte-identical to the field being entirely absent");
  assert.ok(!withoutField.includes("[IMPACTED:"), "no inline marker may render when crossRepoImpact is absent");
});

test("A-R3-C-R6(4): a link present in serviceLinks but NOT in crossRepoImpact.impactedLinks renders with NO marker prefix in the worker prompt", () => {
  const unmatchedLink = {
    from: { repo: "org/front", file: "src/other.ts", symbol: "getOther" },
    to: { repo: "org/other", file: "src/routes.ts", symbol: "GET /other" },
    transport: "http" as const,
    contractRef: "GET /other",
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildWorkerPrompt(mkWorkerInput({
    serviceLinks: [link1, unmatchedLink],
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "impacted-symbol" }] },
  }));
  assert.match(text, /\[IMPACTED:impacted-symbol\] `org\/front\/src\/api\.ts#getOrder`/, "the matched link must carry the marker");
  assert.doesNotMatch(
    text.split("\n").find((l) => l.includes("getOther")) ?? "",
    /\[IMPACTED:/,
    "an unmatched link's bullet must render with NO [IMPACTED:...] prefix",
  );
});

test("A-R3-C-R6(5): an impacted link past the MAX_LINKS cut still renders WITH its marker in the worker prompt — impacted links survive truncation", () => {
  const filler = Array.from({ length: 44 }, (_, i) => ({
    from: { repo: "org/front", file: `src/f${i}.ts`, symbol: `call${i}` },
    to: { repo: "org/other", file: "src/routes.ts", symbol: `GET /f${i}` },
    transport: "http" as const,
    contractRef: `GET /f${i}`,
    confidence: 0.9,
    source: "openapi",
  }));
  const text = buildWorkerPrompt(mkWorkerInput({
    serviceLinks: [...filler, link1], // the impacted link sits at index 44 — past the 40-link ceiling
    crossRepoImpact: { impactedLinks: [{ link: link1, tier: "contract-file" }] },
  }));
  assert.match(
    text,
    /\[IMPACTED:contract-file\] `org\/front\/src\/api\.ts#getOrder`/,
    "the impacted link must survive the MAX_LINKS truncation with its marker in the worker prompt — discovery order must not silently drop the one annotated link",
  );
});

test("A-R3(2): worker prompt with contractDrift renders the 'Contract drift (WARNINGS' sub-heading", () => {
  const text = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [link1], contractDrift: [drift1] }));
  assert.match(text, /Contract drift \(WARNINGS/, "worker prompt must render the drift sub-heading");
  assert.match(text, /DELETE \/orders\/\{id\}/, "worker prompt must render the drift verb+path");
});

test("A-R3(3): worker prompt with absent serviceLinks/contractDrift renders NO 'Cross-service links' section", () => {
  const text = buildWorkerPrompt(mkWorkerInput({}));
  assert.ok(!text.includes("Cross-service links"), "worker prompt without serviceLinks/contractDrift must render no section");
});

test("A-R3(4): worker prompt with empty serviceLinks array is byte-identical to the field being entirely absent", () => {
  const withEmpty = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [] }));
  const withoutField = buildWorkerPrompt(mkWorkerInput({}));
  assert.equal(withEmpty, withoutField, "an empty serviceLinks array must be byte-identical to the field being entirely absent");
});

test("A-R3(5): worker prompt caps serviceLinks at MAX_LINKS (40) and contractDrift at MAX_DRIFT (20)", () => {
  const manyLinks = Array.from({ length: 45 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: `route${i}` },
    transport: "http" as const,
    confidence: 0.5,
    source: "openapi",
  }));
  const manyDrift = Array.from({ length: 25 }, (_, i) => ({
    from: { repo: "org/front", file: "src/api.ts", symbol: `sym${i}` },
    verb: "GET",
    path: `/path${i}`,
  }));
  const text = buildWorkerPrompt(mkWorkerInput({ serviceLinks: manyLinks, contractDrift: manyDrift }));
  assert.ok(text.includes("sym0") && text.includes("sym39"), "the first 40 links must render");
  assert.ok(!text.includes("sym40") && !text.includes("sym44"), "links beyond the 40-cap must be dropped");
  assert.ok(text.includes("/path0") && text.includes("/path19"), "the first 20 drift entries must render");
  assert.ok(!text.includes("/path20") && !text.includes("/path24"), "drift entries beyond the 20-cap must be dropped");
});

test("A-R3(6): worker prompt serviceLinks string fields pass through the local s() sanitize wrapper", () => {
  const dirtyLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "const k = sk-abc123XYZsecretvalue" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const text = buildWorkerPrompt(mkWorkerInput({ serviceLinks: [dirtyLink] }));
  assert.ok(!text.includes("sk-abc123XYZsecretvalue"), "a secret-shaped string in a worker serviceLinks field must be redacted, never passed through raw");
  assert.match(text, /REDACTED/, "the sanitize wrapper must have actually redacted the secret pattern");
});

// ── WS5.1: capDiff is wired at every render boundary that embeds the raw diff ───────────────────
// PromptBudgetPort's capDiff existed but was never called — buildDiffSection (the e2e task-band diff
// section), buildCodeTask (code-mode diff), and buildExplorerPrompt (the explorer's diff embed) all
// interpolated `sanitizeText(input.diff).text` UNCAPPED. A giant commit (huge autogenerated file,
// vendored dependency, wide refactor) could blow the per-role prompt budget on the diff ALONE before
// the assembler's own shedding logic ever runs. capDiff keeps whole per-file sections in relevance
// order and appends a truncation marker naming the omitted files + how to read the full diff.

// Build a diff comfortably over MAX_PROMPT_DIFF_CHARS (50,000) so capDiff's truncation branch fires.
function bigDiff(fileCount = 5, linesPerFile = 3000): string {
  const parts: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    parts.push(`diff --git a/src/big-file-${i}.ts b/src/big-file-${i}.ts`);
    parts.push(`--- a/src/big-file-${i}.ts`);
    parts.push(`+++ b/src/big-file-${i}.ts`);
    parts.push(`@@ -1,1 +1,${linesPerFile} @@`);
    for (let l = 0; l < linesPerFile; l++) parts.push(`+const line${i}_${l} = "padding to blow the prompt budget";`);
  }
  return parts.join("\n");
}

test("WS5.1: buildDiffSection (e2e diff-mode task-band section) caps a giant diff instead of embedding it whole", () => {
  const huge = bigDiff();
  const text = buildPrompt(mkInput({ diff: huge, mode: "diff" }));
  assert.ok(text.length < huge.length, "the assembled prompt must be smaller than the raw uncapped diff");
  assert.match(text, /diff truncated/i, "a visible truncation marker must be present");
  assert.match(text, /git show/, "the marker must point the agent at `git show <sha>` for the full diff");
});

test("WS5.1: buildCodeTask (code-mode diff task) caps a giant diff instead of embedding it whole", () => {
  const huge = bigDiff();
  const text = buildPrompt(mkInput({ diff: huge, mode: "diff", target: "code" }));
  assert.ok(text.length < huge.length, "the code-mode task must not embed the raw uncapped diff");
  assert.match(text, /diff truncated/i, "a visible truncation marker must be present in code mode too");
});

test("WS5.1: buildExplorerPrompt caps a giant diff instead of embedding it whole", () => {
  const huge = bigDiff();
  const text = buildExplorerPrompt(mkInput({ diff: huge, mode: "diff" }));
  assert.ok(text.length < huge.length, "the explorer prompt must not embed the raw uncapped diff");
  assert.match(text, /diff truncated/i, "a visible truncation marker must be present in the explorer prompt too");
});

test("WS5.1: a small diff (under the cap) passes through buildDiffSection unmodified (no spurious truncation)", () => {
  const small = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n";
  const text = buildPrompt(mkInput({ diff: small, mode: "diff" }));
  assert.ok(text.includes("export function foo()"), "a small diff must render in full");
  assert.doesNotMatch(text, /diff truncated/i, "a small diff must not trigger the truncation marker");
});

// Judgment-day: the planner (buildPlanPromptAssembled, diff mode) was the 5th raw-diff render site —
// it ran on EVERY diff/manual run BEFORE generator/reviewer, embedding `sanitizeText(input.diff).text`
// uncapped inside the plan-change section (no maxBytes, default overflow:"drop"). A diff big enough to
// blow the qa-generator role budget on its own shed the WHOLE plan-change section — diff, change
// intent AND commit message together — leaving the planner blind (judge-verified live: an 850KB diff
// reduced the assembled planner prompt to a ~2.8KB shell). This pins the fix: cappedDiffText at the
// planner site + plan-change's own maxBytes/overflow:"summarize" backstop.
test("judgment-day PIN: the planner's plan-change section survives a diff far larger than the qa-generator role budget", () => {
  const huge = bigDiff();
  const result = buildPlanPromptAssembled(mkInput({ diff: huge, mode: "diff" }));
  assert.match(result.text, /diff truncated/i, "the diff embed itself must be capped (capDiff) with a visible marker");
  assert.match(
    result.text,
    /## Change intent \(Conventional Commits\)/,
    `plan-change must survive whole, not be dropped by the section-level shed. sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.match(
    result.text,
    /## Commit message/,
    `the commit message inside plan-change must survive alongside the capped diff. sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
  assert.ok(
    Buffer.byteLength(result.text, "utf8") <= roleWindowBytes("qa-generator"),
    `the assembled planner prompt must respect the qa-generator role budget. sectionSizes: ${JSON.stringify(result.sectionSizes)}`,
  );
});

test("WS5.1: reviewObjective/commitDiffObjective (reviewer diff objective) caps a giant diff instead of embedding it whole", () => {
  const huge = bigDiff();
  const reviewInput: ReviewInput = {
    diff: huge,
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(text.length < huge.length, "the reviewer prompt must be smaller than the raw uncapped diff");
  assert.match(text, /diff truncated/i, "a visible truncation marker must be present");
  assert.match(text, /git show/, "the marker must point the agent at `git show <sha>` for the full diff");
});

test("reviewer defense-in-depth: a >capDiff diff never starves the specs/dom sections", () => {
  const huge = bigDiff();
  const { text } = buildReviewerPromptAssembled({
    diff: huge,
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    domSnapshot: "button: Submit\nheading: Checkout",
  });
  assert.match(text, /diff truncated/i, "the objective must be capped, not dropped");
  assert.match(text, /## Specs to review/, "reviewer-specs must survive");
  assert.match(text, /Live DEV DOM/, "reviewer-dom must survive");
  assert.ok(
    Buffer.byteLength(text, "utf8") <= roleWindowBytes("qa-reviewer"),
    "the assembled reviewer prompt must respect the reviewer role's byte budget",
  );
});

test("WS5.1: a small diff (under the cap) at the reviewer site passes through unmodified", () => {
  const small = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n";
  const reviewInput: ReviewInput = {
    diff: small,
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
  };
  const text = buildReviewerPrompt(reviewInput);
  assert.ok(text.includes("export function foo()"), "a small diff must render in full");
  assert.doesNotMatch(text, /diff truncated/i, "a small diff must not trigger the truncation marker");
});

// ── Judgment-day round 2 (reviewer-budget-starvation): the "reviewer defense-in-depth" test above
// never actually reaches the reviewer-dom/reviewer-specs maxBytes backstops — capDiff already bounds
// the diff to ~50,000 chars before the section-level cap ever sees it, so reverting the
// maxBytes/overflow additions on those sections still passes it trivially. This test drives an
// oversized DOM snapshot directly (independent of the diff/capDiff) so the reviewer-dom section's
// OWN 20,000B cap is what fires.
test("reviewer defense-in-depth actually FIRES: an oversized DOM snapshot alone (no huge diff) triggers the reviewer-dom maxBytes backstop", () => {
  const oversizedDom = padTo("button: Submit\nheading: Checkout\n", 25_000);
  const { text } = buildReviewerPromptAssembled({
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "testapp",
    mode: "diff",
    domSnapshot: oversizedDom,
  });
  assert.match(
    text,
    /## Live DEV DOM/,
    "reviewer-dom must be PRESENT despite exceeding its own 20,000B cap — a 'drop' overflow policy would omit it entirely",
  );
  assert.match(
    text,
    /capped at 20000 bytes/,
    "the visible per-section truncation marker naming reviewer-dom's own maxBytes must appear",
  );
  assert.ok(
    Buffer.byteLength(text, "utf8") <= roleWindowBytes("qa-reviewer"),
    "the assembled reviewer prompt must still respect the reviewer role's byte budget",
  );
});

// ── WS5.2: coverage-gap must survive its own regen prompt ────────────────────────────────────────
// The coverage-gap section was rendered at VOLATILE priority 5 — the HIGHEST priority number in the
// volatile band, which the assembler sheds FIRST under budget pressure (see context-assembler.ts's
// own SHED_ROLE_ORDER + "higher priority number → shed first" comment). On an enforce-mode coverage
// regen, coverage-gap is the ENTIRE PAYLOAD of the turn — a shed here silently converts the one-shot
// regen into a blind repeat of the original prompt (the diff is also empty on regens). Promote it to
// shedAs:"critical-recap" (the pack's own precedent for unrecoverable-this-turn content) so it
// survives everything else in the volatile band.
test("WS5.2: coverage-gap survives when other volatile content is large enough to force shedding", () => {
  // qa-generator's real budget is deepseek-v4-pro's window (64,000 tokens x 0.75 safety margin x 4
  // bytes/token = 192,000 bytes) — the payload below must genuinely exceed that so the assembler's
  // global-budget pass actually sheds something, not merely construct a payload that already fits.
  // learnedRules (volatile priority 2, sheds AFTER coverage-gap under the OLD priority-5 ordering)
  // plus a large domSnapshot (volatile priority 1, sheds even later) together blow the real budget;
  // if coverage-gap is not promoted to the critical-recap shed band, it sheds FIRST and is lost.
  const bigLearnedRules = "## Lessons\n" + "x".repeat(120_000);
  const bigDom = "button: Submit\n" + "row: item ".repeat(15_000);
  const coverageGapText = "## COVERAGE_GAP_UNIQUE_MARKER\nsrc/checkout.ts:42-58 not exercised by the green run.";
  const text = buildPrompt(mkInput({
    coverageGap: coverageGapText,
    learnedRules: bigLearnedRules,
    domSnapshot: bigDom,
  }));
  assert.ok(text.includes("COVERAGE_GAP_UNIQUE_MARKER"), "the coverage-gap section must survive assembly even under real budget pressure");
});

// ── WS5.5(b): "Cross-check against the diff" must be conditional on the diff actually rendering ──
// buildTask's e2e diff branch always rendered "Cross-check against the diff", but the diff ITSELF
// lives in a separate section (buildDiffSection) that returns "" on any regen pass (fixCases /
// reviewCorrections / coverageGap) — so a regen prompt commanded the agent to cross-check evidence
// that was never in the prompt at all.
test("WS5.5b: a first-pass (non-regen) e2e prompt renders 'Cross-check against the diff' alongside the diff", () => {
  const text = buildPrompt(mkInput({ mode: "diff" }));
  assert.match(text, /Cross-check against the diff/, "first pass: the diff renders, so the instruction is valid");
  assert.match(text, /## Commit diff/, "first pass: the diff section itself must be present");
});

test("WS5.5b: a fixCases regen prompt does NOT render 'Cross-check against the diff' (the diff section is empty on regen)", () => {
  const text = buildPrompt(mkInput({ mode: "diff", fixCases: [failingCase] }));
  assert.doesNotMatch(text, /Cross-check against the diff/, "regen: no diff section exists, so the instruction must not appear either");
});

test("WS5.5b: a reviewCorrections regen prompt does NOT render 'Cross-check against the diff'", () => {
  const text = buildPrompt(mkInput({ mode: "diff", reviewCorrections: ["[fragile-selector] tighten the locator"] }));
  assert.doesNotMatch(text, /Cross-check against the diff/, "reviewer-corrections regen: no diff section, instruction must not appear");
});

test("WS5.5b: a coverageGap regen prompt does NOT render 'Cross-check against the diff'", () => {
  const text = buildPrompt(mkInput({ mode: "diff", coverageGap: "src/checkout.ts:42-58" }));
  assert.doesNotMatch(text, /Cross-check against the diff/, "coverage-gap regen: no diff section, instruction must not appear");
});

// ── WS5.5(d): static-gate fixCases framing ────────────────────────────────────────────────────
// WS4.3 threads the static-gate (Filter B: tsc/eslint) validation errors as a synthetic fixCases
// entry named "static-gate" so the repair round has the actual error text. But the fixCases section
// unconditionally frames EVERY entry as "tests FAILED during execution against DEV" — misleading
// for a compile/lint failure, since nothing was ever executed. Gate the framing on the case name.
const staticGateCase: QaCase = { name: "static-gate", status: "fail", detail: "TS2322: Type 'string' is not assignable to type 'number'." };

test("WS5.5d: a static-gate fixCases entry renders under a 'failing gate' framing, not 'FAILED during execution against DEV'", () => {
  const text = buildPrompt(mkInput({ fixCases: [staticGateCase] }));
  assert.doesNotMatch(text, /FAILED during execution against DEV/, "a compile/lint failure never executed against DEV — the execution framing is misleading here");
  assert.match(text, /failing gate/i, "the static-gate case must render under a distinct 'failing gate' framing");
  assert.match(text, /TS2322/, "the actual validation error text must still be present");
});

test("WS5.5d: an ordinary (non-static-gate) fixCases entry keeps the original 'FAILED during execution against DEV' framing", () => {
  const text = buildPrompt(mkInput({ fixCases: [failingCase] }));
  assert.match(text, /FAILED during execution against DEV/, "a real Playwright execution failure keeps its original framing");
});

test("WS5.2: the assembled coverage-gap section survives a tiny budget that sheds a lower-priority-number volatile section instead", () => {
  // Direct structural check against the ACTUAL section descriptor buildPromptAssembled constructs
  // for coverage-gap (priority 5, shedAs "critical-recap") vs. a lower-priority-number volatile
  // section (dom-snapshot, priority 1 — sheds SECOND under the old per-priority-number ordering,
  // but FIRST once coverage-gap is promoted to the critical-recap shed band).
  const coverageText = "## Cover the change (HIGH priority)\n\nCOVERAGE_GAP_UNIQUE_MARKER";
  const domText = "## Live DEV accessibility tree\n" + "x".repeat(5000);
  const budgetBytes = Buffer.byteLength(coverageText, "utf8") + 50; // room for coverage-gap alone, not both
  const assembled = caAssemble([
    caSection("dom-snapshot", "volatile", domText, { priority: 1 }),
    caSection("coverage-gap", "volatile", coverageText, { priority: 5, shedAs: "critical-recap" }),
  ], { budgetBytes });
  assert.ok(assembled.text.includes("COVERAGE_GAP_UNIQUE_MARKER"), "coverage-gap (shedAs critical-recap) must survive the tiny budget");
  assert.ok(assembled.sectionSizes["coverage-gap"] !== undefined, "coverage-gap must be present in sectionSizes (not shed)");
  assert.ok(assembled.sectionSizes["dom-snapshot"] === undefined, "dom-snapshot (shedAs volatile, its own default band) must be the one shed instead");
});

// ── Cross-repo prompt wording honesty (service-context staging fix) ──────────────────────────
// input.service.mirrorDir / input.services[].mirrorDir now carry a STAGED, bounded snapshot
// (src/server/service-context.ts), never the service's full working copy — the wording must say
// so, and any OpenAPI hint must be rendered under the contracts/ prefix the staging actually uses.

test("cross-repo diff task: describes the service path as a staged READ-ONLY snapshot, never a 'working copy', and prefixes the openapi hint with contracts/", () => {
  const text = buildPrompt(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/work/e2e/.qa/service-context/org__orders-svc", openapi: "openapi/orders.yaml" },
  }));
  assert.match(text, /READ-ONLY staged snapshot/i);
  assert.doesNotMatch(text, /working copy/i, "the generation task must never claim a full working copy is available");
  assert.match(text, /contracts\/openapi\/orders\.yaml/, "the openapi hint must point at the contracts/ prefix staging actually uses");
});

test("cross-repo diff task: an array openapi hint is prefixed per-entry, not just on the joined string", () => {
  const text = buildPrompt(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] },
  }));
  assert.match(text, /contracts\/openapi\/orders\.yaml/);
  assert.match(text, /contracts\/openapi\/payments\.yaml/);
});

test("cross-repo explorer prompt (diff mode): describes a staged snapshot, never a 'working copy'", () => {
  const text = buildExplorerPrompt(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc" },
  }));
  assert.match(text, /READ-ONLY staged snapshot/i);
  assert.doesNotMatch(text, /working copy/i);
});

test("cross-repo explorer prompt (manual mode): describes a staged snapshot, never a 'working copy'", () => {
  const text = buildExplorerPrompt(mkInput({
    mode: "manual",
    guidance: "test the checkout flow",
    service: { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc" },
  }));
  assert.match(text, /READ-ONLY staged snapshot/i);
  assert.doesNotMatch(text, /working copy/i);
});

test("cross-repo planner prompt: describes a staged snapshot, never a 'working copy'", () => {
  const text = buildPlanPromptAssembled(mkInput({
    service: { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc" },
  })).text;
  assert.match(text, /READ-ONLY staged snapshot|staged working copy at/i);
  assert.doesNotMatch(text, /\(read-only working copy at/i);
});

test("buildContextTask: describes each microservice path as a staged contract snapshot, never a mirrored working copy, and prefixes hints with contracts/", () => {
  const text = buildContextTask(mkInput({
    mode: "context",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/staged/org__orders-svc", openapi: "openapi/orders.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/staged/org__payments-svc" },
    ],
  }));
  assert.match(text, /staged contract snapshot/i);
  assert.doesNotMatch(text, /mirrored READ-ONLY|working copy/i);
  assert.match(text, /contracts\/openapi\/orders\.yaml/);
  assert.match(text, /staged contract snapshots are local paths you can read/i);
});

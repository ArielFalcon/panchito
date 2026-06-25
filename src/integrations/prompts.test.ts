import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPromptAssembled, buildPlanPromptAssembled, buildFollowupPrompt } from "./prompts";
import { assemble as caAssemble, section as caSection } from "./context-assembler";
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
// Asserts that learned-rules SURVIVES while coverage-gap is shed — proving learned-rules is at
// priority 2, not priority 6.
// This test FAILS if prompts.ts line ~828 is reverted to `priority: 6`:
//   with p6 > p5, learned-rules sheds BEFORE coverage-gap, so LEARNED_MARKER is absent.
test("seam-d PINNING: learned-rules (real prompts.ts p2) survives budget pressure that sheds coverage-gap (p5)", () => {
  const LEARNED_MARKER = "PINNING_LEARNED_RULES_MARKER";
  const GAP_MARKER = "PINNING_COVERAGE_GAP_MARKER";

  // Each section ~100k bytes. Together ~200k — exceeds the 192k role budget (kimi-k2.7-code:
  // 64k tokens × 0.75 safety × 4 bytes/token = 192k). At least one volatile section must shed.
  // Shed order in volatile band: highest priority number first.
  // With p2 (learned-rules) vs p5 (coverage-gap): p5 > p2 → coverage-gap sheds first.
  // With p6 (reverted): p6 > p5 → learned-rules sheds first. Assertion fails → RED.
  const learnedContent = padTo(LEARNED_MARKER, 100_000);
  const gapContent = padTo(GAP_MARKER, 100_000);

  const result = buildPromptAssembled(mkInput({
    mode: "diff",
    learnedRules: learnedContent,
    coverageGap: gapContent,
  }));

  assert.ok(
    result.text.includes(LEARNED_MARKER),
    `learned-rules (prompts.ts priority 2) must survive budget pressure — coverage-gap (p5) must shed first. ` +
    `If this fails, prompts.ts line ~828 may have been reverted to priority 6. ` +
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildContextTask,
  parseVerdict,
  extractJsonObjects,
  specFileForFlow,
  agentTimeout,
  buildWorkerPrompt,
  buildExplorerPrompt,
  renderArchitectureContext,
  buildReviewerPrompt,
  buildReviewerPromptAssembled,
  renderExecutionResult,
  AgentDeps,
  AgentTurnEvent,
  OpencodeRunInput,
  ReviewInput,
  askAssistant,
} from "./opencode-client";
import type { ArchitectureContext } from "../qa/context";
import type { ExplorationBrief } from "../qa/exploration-brief";
import type { ParallelWorkerInput } from "@contexts/generation/application/ports/generation-ports.ts";
// migration-tier-4c Slice 5a: model-window-catalog.ts relocated to qa-engine (a prompts.ts sibling).
import { roleWindowBytes } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";

// context.json is read from the WATCHED repo and committed by this system's own PRs, so it
// is attacker-influenceable. It must be sanitized before reaching the test-writing agent.
test("renderArchitectureContext sanitizes injected fields (no prompt-injection / secret leak)", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234def",
    routes: [{ path: "/x", name: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    api: [],
    feBe: [],
  };
  const out = renderArchitectureContext(ctx) ?? "";
  assert.doesNotMatch(out, /ghp_AAAA/, "a token in context.json must be redacted before the prompt");
});

test("renderArchitectureContext: a root route '/' does not scope-match every changed file (M9)", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234def",
    routes: [{ path: "/" }, { path: "/checkout" }],
    api: [{ operationId: "pay", method: "POST", path: "/pay" }],
    feBe: [
      { route: "/", operationId: "pay" }, // route "/" would match any file path via includes()
      { route: "/checkout", operationId: "pay" },
    ],
  };
  const out = renderArchitectureContext(ctx, ["src/unrelated.ts"]) ?? "";
  // The "/" link must NOT be pulled in as "relevant" just because every path contains "/".
  assert.doesNotMatch(out, /Route `\/` →/, "root-route link must not match every changed file");
});

const input: OpencodeRunInput = {
  repo: "org/demo",
  sha: "abc123",
  diff: "diff --git a/x b/x\n+const x = 1;",
  mirrorDir: "/mirrors/org__demo",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc123",
  needsReview: true,
  target: "e2e",
  mode: "diff",
  appName: "demo-app",
  intent: { type: "feat", breaking: false, message: "feat: new screen", changedFiles: ["src/x.ts"] },
};


test("buildPrompt includes repo, sha, namespace, e2e folder and the diff", () => {
  const p = buildPrompt(input);
  assert.match(p, /abc123/);
  assert.match(p, /org\/demo/);
  assert.match(p, /qa-bot-abc123/);
  assert.match(p, /e2e\//);
  assert.match(p, /const x = 1;/);
  assert.match(p, /independent reviewer/i);
  assert.match(p, /project="demo-app"/);
});

test("buildPrompt includes the commit intent and specMetas instruction for deterministic manifest", () => {
  const p = buildPrompt(input);
  assert.match(p, /Type: feat/);
  assert.match(p, /feat: new screen/);
  assert.match(p, /src\/x\.ts/); // changed files (scope)
  assert.match(p, /specMetas/); // instructs agent to include structured metadata in verdict
});

test("buildPrompt sanitizes the diff (defense in depth)", () => {
  // sdd/migration-wiring-phase-2 Slice 6b: cappedDiffText now sanitizes the diff in "model" mode
  // (previously "issue" mode — see that function's own doc for why). A quoted-literal value is a
  // real secret shape in EITHER mode (isModelModeSecretValue's own "a quoted literal is the
  // deliberate secret shape" rule), so this fixture still proves the diff is never sent raw.
  const p = buildPrompt({ ...input, diff: 'password="hunter2xyzSECRET"' });
  assert.doesNotMatch(p, /hunter2xyzSECRET/);
  assert.match(p, /\[REDACTED\]/);
});

test("buildPrompt (Slice 6b, model mode): a bare short unquoted assignment is treated as code-shaped, not a secret — narrower than issue mode by design", () => {
  // WS5.4a's own contract (sanitizer.ts's isModelModeSecretValue): model mode only redacts a quoted
  // string literal or a high-entropy (>=12 chars, mixed-case, has-digit) bare token. "hunter2" is
  // neither (7 chars, no uppercase) — model mode intentionally leaves it alone, trading a weak-secret
  // false negative for not mangling ordinary auth-shaped code sent to the generator (the same
  // trade-off that motivated adding "model" mode in the first place).
  const p = buildPrompt({ ...input, diff: "password=hunter2" });
  assert.match(p, /hunter2/, "model mode must not redact a short bare unquoted value — it reads as code, not a secret literal");
});

test("buildPrompt without review omits the reviewer instruction", () => {
  const p = buildPrompt({ ...input, needsReview: false });
  assert.match(p, /Review disabled for this run/);
  assert.doesNotMatch(p, /independent reviewer/i);
});

test("buildPrompt includes the OpenAPI hint and the no-direct-call rule when configured", () => {
  const p = buildPrompt({ ...input, openapi: "**/src/main/resources/openapi/*.yaml" });
  assert.match(p, /OpenAPI contract/);
  assert.match(p, /src\/main\/resources\/openapi/);
  assert.match(p, /never call the API directly/);
});

test("buildPrompt joins multiple OpenAPI globs and omits the line when no hint is set", () => {
  const many = buildPrompt({ ...input, openapi: ["a/openapi.yaml", "b/api-definition.yaml"] });
  assert.match(many, /a\/openapi\.yaml, b\/api-definition\.yaml/);
  assert.doesNotMatch(buildPrompt(input), /OpenAPI contract/); // input has no openapi → no line
});

// ── A' (commit body context) + B' (shared acceptance criterion): the diff/manual objective sharpening ──

test("A' buildPrompt (diff) merges subject + body into ONE commit-message block (no separate section)", () => {
  const withBody = { ...input, intent: { ...input.intent!, body: "Owners with >10 pets were overcharged because the cart re-queried after the discount." } };
  const p = buildPrompt(withBody);
  assert.match(p, /## Commit message/);
  assert.match(p, /feat: new screen/); // the subject
  assert.match(p, /Owners with >10 pets were overcharged/); // the body — same block
  assert.doesNotMatch(p, /Why this change/); // merged: no separate body section
});

test("A' buildPrompt (diff) renders just the subject when the commit has no body", () => {
  const p = buildPrompt(input); // input.intent has no body
  assert.match(p, /## Commit message/);
  assert.match(p, /feat: new screen/);
});

test("A' buildPrompt sanitizes the commit body (defense in depth — the body is attacker-influenceable prose)", () => {
  const withSecret = { ...input, intent: { ...input.intent!, body: "deploy with token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
  const p = buildPrompt(withSecret);
  assert.doesNotMatch(p, /ghp_aaaaaaaaaaaa/);
  assert.match(p, /\[REDACTED\]/);
});

test("A' buildPrompt caps a huge commit body so it cannot blow the prompt budget", () => {
  const huge = "behavioral note. ".repeat(1000); // ~17k chars, well over the 4k cap
  const p = buildPrompt({ ...input, intent: { ...input.intent!, body: huge } });
  assert.match(p, /body truncated/);
  assert.ok(!p.includes(huge), "the full uncapped body must not appear in the prompt");
});

test("A' buildPrompt does NOT render the body on a re-generation pass (objective already established; protects the largest prompts)", () => {
  const reGen = { ...input, intent: { ...input.intent!, body: "first-pass-only body marker" }, fixCases: [{ name: "owners", status: "fail" as const, detail: "boom" }] };
  assert.doesNotMatch(buildPrompt(reGen), /first-pass-only body marker/);
});

test("B' buildPrompt (diff) states a concrete acceptance criterion tied to the change before writing", () => {
  const p = buildPrompt(input);
  assert.match(p, /commit to this BEFORE writing/);
  assert.match(p, /observable OUTCOME/);
  assert.match(p, /must fail if this specific behavior regresses/i);
});

test("B' buildPrompt (manual) carries the SAME acceptance criterion — manual is a first-class focused path", () => {
  const p = buildPrompt({ ...input, mode: "manual", guidance: "test the contact form submits and shows a thank-you" });
  assert.match(p, /test the contact form submits/); // the guidance IS the objective
  assert.match(p, /commit to this BEFORE writing/);
  assert.match(p, /observable OUTCOME/);
});

test("A' buildExplorerPrompt renders the commit message (subject + body) so the explorer infers a concrete objective", () => {
  const withBody = { ...input, intent: { ...input.intent!, body: "the discount must persist after the cart re-queries" } };
  const e = buildExplorerPrompt(withBody);
  assert.match(e, /## Commit message/);
  assert.match(e, /discount must persist/);
});

test("buildPrompt complete mode: whole-repo analysis + persisted coverage", () => {
  const p = buildPrompt({ ...input, mode: "complete", intent: undefined });
  assert.match(p, /WHOLE repository/);
  assert.match(p, /COVERAGE \+ IMPORTANCE map/);
  assert.match(p, /analysis\.json/);
  assert.match(p, /UNCOVERED flows/);
  assert.doesNotMatch(p, /## Commit diff/); // no diff for whole-repo mode
});

test("buildPrompt exhaustive mode: re-evaluates the whole suite", () => {
  const p = buildPrompt({ ...input, mode: "exhaustive", intent: undefined });
  assert.match(p, /REGENERATE the entire E2E suite/);
  assert.match(p, /Re-evaluate EVERY existing test/);
});

test("buildPrompt manual mode: includes the user guidance", () => {
  const p = buildPrompt({ ...input, mode: "manual", intent: undefined, guidance: "test the contact form validation" });
  assert.match(p, /FOCUSED on the following guidance/);
  assert.match(p, /contact form validation/);
});

test("parseVerdict reads the closing JSON (in a ```json block)", () => {
  const v = parseVerdict('blah blah\n```json\n{ "approved": true, "specs": ["a.spec.ts"], "note": "" }\n```');
  assert.equal(v.approved, true);
  assert.deepEqual(v.specs, ["a.spec.ts"]);
});

test("parseVerdict takes the LAST valid object", () => {
  const v = parseVerdict('{"approved": true}\nthen\n{ "approved": false, "note": "did not converge" }');
  assert.equal(v.approved, false);
  assert.equal(v.note, "did not converge");
});

test("parseVerdict with no verdict fails closed (approved=false) and flags the parse miss", () => {
  const v = parseVerdict("the agent said nothing structured");
  assert.equal(v.approved, false);
  assert.equal(v.parsed, false); // distinguishes a parse miss from an explicit rejection
});

test("parseVerdict flags a successfully parsed verdict", () => {
  assert.equal(parseVerdict('{ "approved": false, "specs": [] }').parsed, true);
});

test("parseVerdict reads the new generator contract (specs, no approved) — approval is the reviewer's job", () => {
  // The generator no longer self-reports `approved`: the independent reviewer is the gate.
  // The closing block is identified by its `specs` array, and a MISSING `approved` must not be
  // read as a rejection (that would fail-close every run under the new contract).
  const v = parseVerdict(
    'done.\n{ "specs": ["login.spec.ts"], "specMetas": [{"file":"login.spec.ts","flow":"login","objective":"valid creds reach the dashboard","targets":[]}], "note": "" }',
  );
  assert.equal(v.parsed, true);
  assert.deepEqual(v.specs, ["login.spec.ts"]);
  assert.equal(v.approved, true); // default for the specs-only contract; the reviewer decides for real
  assert.equal(v.specMetas?.length, 1);
});

test("parseVerdict handles a verdict with a NESTED object (regression: old regex truncated it)", () => {
  const v = parseVerdict('done.\n{"approved": true, "specs": ["a.spec.ts"], "meta": {"changeRef": {"sha": "x"}}}');
  assert.equal(v.parsed, true);
  assert.equal(v.approved, true);
  assert.deepEqual(v.specs, ["a.spec.ts"]);
});

test("parseVerdict ignores a brace inside a string and a non-verdict trailing object", () => {
  const v = parseVerdict('{"approved": true, "note": "use the } char"}\nlater: {"unrelated": 1}');
  assert.equal(v.approved, true);
  assert.equal(v.note, "use the } char");
});

test("parseVerdict extracts specMetas with flow, objective, and targets", () => {
  const v = parseVerdict(`{
    "approved": true,
    "specs": ["login.spec.ts", "checkout.spec.ts"],
    "specMetas": [
      {"file": "login.spec.ts", "flow": "login", "objective": "given valid credentials, when login, then redirect to dashboard", "targets": ["LoginComponent", "/api/auth"]},
      {"file": "checkout.spec.ts", "flow": "checkout", "objective": "given items in cart, when checkout, then order is created", "targets": ["CheckoutPage", "createOrder"]}
    ]
  }`);
  assert.equal(v.approved, true);
  assert.equal(v.specs.length, 2);
  assert.ok(v.specMetas);
  assert.equal(v.specMetas!.length, 2);
  assert.deepEqual(v.specMetas![0], {
    file: "login.spec.ts",
    flow: "login",
    objective: "given valid credentials, when login, then redirect to dashboard",
    targets: ["LoginComponent", "/api/auth"],
  });
});

test("parseVerdict drops specMetas entries missing required fields", () => {
  const v = parseVerdict(`{
    "approved": true,
    "specMetas": [
      {"file": "ok.spec.ts", "flow": "ok", "objective": "test something", "targets": ["X"]},
      {"file": "", "flow": "bad", "objective": "nope", "targets": []},
      {"flow": "no-file", "objective": "nothing"},
      "not-an-object"
    ]
  }`);
  assert.ok(v.specMetas);
  assert.equal(v.specMetas!.length, 1);
  assert.equal(v.specMetas![0]!.file, "ok.spec.ts");
});

// startEventStreamWithReconnect/EventStreamManager tests MOVED to qa-engine/test/contexts/
// generation/infrastructure/sse/event-stream.test.ts (migration-tier-4c Slice 3) — the lifecycle
// itself migrated there; LiveActivity/activityRouter/registerRunSession/unregisterRunSession/
// startActivitySink are still re-exported from "./opencode-client" for other consumers.

test("parseVerdict returns undefined specMetas when absent or empty", () => {
  assert.equal(parseVerdict('{"approved": true, "specs": ["a.spec.ts"]}').specMetas, undefined);
  assert.equal(parseVerdict('{"approved": true, "specMetas": "not-array"}').specMetas, undefined);
  assert.equal(parseVerdict('{"approved": true, "specMetas": []}').specMetas, undefined);
});

test("extractJsonObjects returns balanced top-level objects in order, skipping invalid spans", () => {
  const objs = extractJsonObjects('noise {"a":1} mid {"b":{"c":2}} tail {not json}');
  assert.deepEqual(objs, [{ a: 1 }, { b: { c: 2 } }]);
});

test("buildPrompt surfaces reviewer corrections as the highest-priority block", () => {
  const p = buildPrompt({ ...input, reviewCorrections: ["a.spec.ts: scope the selector to the header"] });
  assert.match(p, /Apply reviewer corrections/);
  assert.match(p, /scope the selector to the header/);
  // it comes before the task body
  assert.ok(p.indexOf("Apply reviewer corrections") < p.indexOf("Generate/update E2E tests"));
});


// ── complete/exhaustive fan-out ──────────────────────────────────────────────


test("buildWorkerPrompt injects the exploration brief and forbids re-exploring the code", () => {
  const brief: ExplorationBrief = {
    builtForSha: "s",
    objective: "pay",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/c.ts", role: "applies the bulk discount" }],
  };
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["CheckoutService.pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "diff", brief };
  const p = buildWorkerPrompt(w);
  assert.match(p, /Exploration brief/);
  assert.match(p, /applies the bulk discount/);
  assert.match(p, /do NOT re-(read|explore)/i);
  assert.match(p, /live DOM/i, "selectors must still be verified against the live DOM");
});

test("buildWorkerPrompt without a brief is unchanged (serena symbols line, back-compat)", () => {
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" };
  const p = buildWorkerPrompt(w);
  assert.match(p, /read them with serena/);
  assert.doesNotMatch(p, /Exploration brief/);
});


// ── Fase 3: explorer pass in the single-agent diff path ──────────────────────

test("buildExplorerPrompt asks a read-only explorer to map the diff into an ExplorationBrief", () => {
  const p = buildExplorerPrompt(input);
  assert.match(p, /abc123/); // the sha
  assert.match(p, /feat: new screen/); // intent message
  assert.match(p, /const x = 1/); // the diff
  assert.match(p, /read-only|do NOT write/i);
  assert.match(p, /ExplorationBrief|brief/i);
});

test("buildPrompt injects the exploration brief and tells the generator not to re-read that code", () => {
  const brief: ExplorationBrief = {
    builtForSha: "abc123",
    objective: "new screen",
    blastRadius: [{ symbol: "Screen.render", file: "src/x.ts", role: "renders the new screen" }],
  };
  const withBrief = buildPrompt({ ...input, contextBrief: brief });
  assert.match(withBrief, /Exploration brief/);
  assert.match(withBrief, /renders the new screen/);
  assert.match(withBrief, /do NOT re-read/i);
  assert.doesNotMatch(buildPrompt(input), /Exploration brief/, "no brief → no brief section (back-compat)");
});


// ── FIX 2: manual mode gets grounding (explorer no longer no-ops for manual) ──────────────

test("FIX 2: buildExplorerPrompt renders the GUIDANCE (not the empty diff) as the manual exploration objective", () => {
  const p = buildExplorerPrompt({
    ...input,
    mode: "manual",
    diff: "", // manual runs carry NO diff
    intent: undefined,
    guidance: "test the contact form submission and validation errors",
  });
  assert.match(p, /test the contact form submission and validation errors/, "the guidance drives the exploration");
  assert.match(p, /Guidance/, "the prompt frames the scope as guidance");
  assert.match(p, /read-only|do NOT write/i);
  assert.match(p, /ExplorationBrief|brief/i);
  assert.doesNotMatch(p, /Commit diff/, "manual must NOT render an empty commit-diff block");
});


test("buildExplorerPrompt sanitizes attacker-influenceable changed-file names", () => {
  const p = buildExplorerPrompt({
    ...input,
    intent: { type: "feat", breaking: false, message: "m", changedFiles: ["src/x.ts", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] },
  });
  assert.doesNotMatch(p, /ghp_AAAA/, "a token in a changed-file name must be redacted");
});


test("specFileForFlow produces a safe path under flows/", () => {
  assert.equal(specFileForFlow("Check Out / Pay!"), "flows/check-out-pay.spec.ts");
  assert.equal(specFileForFlow("   "), "flows/flow.spec.ts");
});

test("buildWorkerPrompt is surgical: exact file, write-early discipline, no manifest writes (Q2: workers do NOT navigate)", () => {
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "complete" };
  const p = buildWorkerPrompt(w);
  assert.match(p, /Write EXACTLY this file: e2e\/flows\/checkout\.spec\.ts/);
  // Q2: workers no longer explore (browser_navigate/browser_snapshot removed from qa-worker MCP).
  // They transcribe the injected a11y tree instead. No LIVE DEV URL line in needsUi branch.
  assert.doesNotMatch(p, /browser_navigate/);
  assert.doesNotMatch(p, /browser_snapshot/);
  assert.doesNotMatch(p, /Explore EFFICIENTLY, then STOP/);
  assert.match(p, /You have NO browser/);
  // The write-early discipline block makes "the file exists" the one required outcome.
  assert.match(p, /required outcome: the file exists on disk/);
  assert.match(p, /TOTAL FAILURE/);
  assert.match(p, /Do NOT write to the manifest/);
  assert.match(p, /\{"spec":"flows\/checkout\.spec\.ts"\}/);
});


test("buildWorkerPrompt injects learnedRules so fan-out workers don't repeat past mistakes", () => {
  const base: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "complete" };
  // Without rules: no lessons block.
  assert.doesNotMatch(buildWorkerPrompt(base), /Lessons learned/);
  // With rules: the block appears, carrying the rule text, before the closing JSON contract.
  const withRules = buildWorkerPrompt({ ...base, learnedRules: "- avoid waitForTimeout; assert on the visible outcome" });
  assert.match(withRules, /Lessons learned from past runs/);
  assert.match(withRules, /avoid waitForTimeout/);
  assert.ok(withRules.indexOf("Lessons learned") < withRules.indexOf('{"spec"'), "lessons precede the JSON contract");
});

// v5 grounding: when the orchestrator captures the live a11y tree for the flow's routes, the worker
// gets it as GROUND TRUTH and TRANSCRIBES real selectors instead of guessing/exploring blind.
test("buildWorkerPrompt injects the live a11y tree as GROUND TRUTH when provided (worker transcribes, not guesses)", () => {
  const base: ParallelWorkerInput = { objective: "list vets", flow: "vets", symbols: [], needsUi: true, specFile: "flows/vets.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "exhaustive" };
  assert.doesNotMatch(buildWorkerPrompt(base), /GROUND TRUTH/); // no snapshot → no block
  const grounded = buildWorkerPrompt({ ...base, domSnapshot: "route /#!/vets:\n  cell: Helen Leary\n  cell: radiology" });
  assert.match(grounded, /GROUND TRUTH/);
  assert.match(grounded, /cell: Helen Leary/);
  assert.match(grounded, /do NOT need to navigate/i); // it stops the worker from burning budget exploring
});


// Phase 1b regression gate: complete/exhaustive paths preserve all functional content and honour
// the canonical STABLE → SEMI-STABLE → VOLATILE → TASK → CRITICAL-RECAP order. These assertions
// are the "section order contract" that must stay green whenever prompts.ts or context-assembler.ts
// are modified.
test("Phase 1b E.5: buildWorkerPrompt assembled output preserves all functional sections in canonical order", () => {
  const base: ParallelWorkerInput = {
    objective: "verify checkout flow",
    flow: "checkout",
    symbols: ["CheckoutPage"],
    needsUi: true,
    specFile: "flows/checkout.spec.ts",
    repo: "r",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    baseUrl: "https://dev",
    appName: "a",
    mode: "complete",
    domSnapshot: "button: Place Order\nbutton: Cancel",
    learnedRules: "- avoid waitForTimeout",
  };

  const { text, sectionSizes } = buildWorkerPromptAssembled(base);

  // All functional sections must be present (content preservation).
  assert.match(text, /Rules/);
  assert.match(text, /Flow: checkout/);
  assert.match(text, /GROUND TRUTH/);
  assert.match(text, /Place Order/);
  assert.match(text, /Lessons learned from past runs/);
  assert.match(text, /avoid waitForTimeout/);
  assert.match(text, /verify checkout flow/);
  assert.match(text, /flows\/checkout\.spec\.ts/);

  // sectionSizes must record all non-empty sections.
  assert.ok("worker-rules" in sectionSizes, "worker-rules in sectionSizes");
  assert.ok("worker-context" in sectionSizes, "worker-context in sectionSizes");
  assert.ok("worker-dom" in sectionSizes, "worker-dom in sectionSizes");
  assert.ok("worker-learned-rules" in sectionSizes, "worker-learned-rules in sectionSizes");
  assert.ok("worker-task" in sectionSizes, "worker-task in sectionSizes");
  assert.ok("worker-output-contract" in sectionSizes, "worker-output-contract in sectionSizes");

  // Canonical order (STABLE < VOLATILE < TASK < CRITICAL-RECAP).
  const rulesIdx = text.indexOf("## Rules");
  const domIdx = text.indexOf("GROUND TRUTH");
  const lessonsIdx = text.indexOf("Lessons learned from past runs");
  const objectiveIdx = text.indexOf("## Objective");
  const contractIdx = text.indexOf('{"spec"');

  assert.ok(rulesIdx < domIdx, "stable-prefix (rules) before volatile (dom)");
  assert.ok(domIdx < lessonsIdx, "dom (volatile p1) before lessons (volatile p2)");
  assert.ok(lessonsIdx < objectiveIdx, "lessons (volatile) before task (objective)");
  assert.ok(objectiveIdx < contractIdx, "task (objective) before critical-recap (output contract)");
});


// parseModelRef/withTimeout/agentErrorToInfra tests MOVED to qa-engine/test/contexts/generation/
// infrastructure/agent-transport-policy.test.ts (migration-tier-4c Slice 2) — the logic itself
// migrated there; these symbols are still re-exported from "./opencode-client" for other consumers.

test("buildPrompt renders the cross-repo service section in diff mode", () => {
  const text = buildPrompt({
    repo: "org/shop-front",
    sha: "a1b2c3d",
    diff: "+ x",
    mirrorDir: "/m/front",
    e2eRelDir: "e2e",
    namespace: "qa-1",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "https://dev.shop.io",
    service: { repo: "org/orders-svc", mirrorDir: "/m/svc", openapi: "api/*.yaml" },
  });
  assert.match(text, /Cross-repo change \(microservice\)/);
  assert.match(text, /org\/orders-svc/);
  assert.match(text, /\/m\/svc/);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /ONLY through the frontend UI/);
});

test("buildPrompt has no cross-repo section without a service", () => {
  const text = buildPrompt({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "+ x", mirrorDir: "/m", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "diff", appName: "shop",
  });
  assert.doesNotMatch(text, /Cross-repo change/);
});

test("buildContextTask renders one extraction section per service", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/m/orders", openapi: "api/*.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/m/payments" },
    ],
  });
  assert.match(text, /Microservice repos \(2\)/);
  assert.match(text, /org\/orders-svc/);
  assert.match(text, /\/m\/orders/);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /"service" field/);
  assert.match(text, /org\/payments-svc/);
  assert.match(text, /\/m\/payments/);
  // No-openapi entry should be present without the hint line
  assert.match(text, /No OpenAPI hint/);
});

test("buildContextTask without services is unchanged (no microservice section)", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
  });
  assert.doesNotMatch(text, /Microservice repos/);
});

// ── Phase 5 regression gate: complete/exhaustive paths are unchanged ──────────
//
// This test pins the CURRENT observable behavior of buildWorkerPrompt for complete/exhaustive
// mode before Phase 5 changed the diff/manual dispatch logic. migration-tier-4c Slice 1 deleted
// the sibling pins for shouldFanOut/runOpencodeParallel/generateParallel/buildPlanPrompt — those
// surfaces were dead (no production caller); this builder is still live.

test("Phase 5 regression gate: buildWorkerPrompt for complete mode preserves objective + context sections", () => {
  // Complete mode workers receive a prompt from buildWorkerPrompt. The prompt must still contain
  // all the key sections a complete-mode worker needs (unchanged by Phase 5).
  const completeWorker: ParallelWorkerInput = {
    objective: "Given the owners list, when the user clicks Add Owner, then a form appears",
    flow: "add-owner",
    symbols: ["OwnerForm", "OwnerController"],
    needsUi: true,
    specFile: "flows/add-owner.spec.ts",
    repo: "org/petclinic",
    mirrorDir: "/m/petclinic",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc",
    baseUrl: "https://dev.petclinic",
    appName: "petclinic",
    mode: "complete",
    domSnapshot: "button: Add Owner\ntextbox: First Name",
    learnedRules: "- avoid waitForTimeout in complete mode",
  };
  const prompt = buildWorkerPrompt(completeWorker);
  // Core task content.
  assert.match(prompt, /flows\/add-owner\.spec\.ts/, "specFile present");
  assert.match(prompt, /Add Owner, then a form appears/, "objective present");
  assert.match(prompt, /OwnerForm/, "symbol present in context");
  // DOM grounding (complete-mode workers get the injected tree).
  assert.match(prompt, /GROUND TRUTH/, "dom grounding section present");
  assert.match(prompt, /Add Owner/, "dom content (button) present");
  // Learned rules injected.
  assert.match(prompt, /avoid waitForTimeout/, "learnedRules present");
  // Output contract present.
  assert.match(prompt, /flows\/add-owner\.spec\.ts.*\}/, "output contract references specFile");
});

// ── Integration tests: OpenCode SDK boundary failure modes ──────────────────

test("askAssistant propagates error when deps.open throws", async () => {
  const failingDeps: AgentDeps = {
    open: async () => { throw new Error("OpenCode unavailable"); },
  };
  await assert.rejects(
    () => askAssistant({ context: "ctx", question: "q?" }, failingDeps, "/m"),
    /OpenCode unavailable/,
  );
});

test("askAssistant requests text-only output so the model's reasoning never leaks", async () => {
  let seenOpts: { textOnly?: boolean } | undefined;
  const deps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async (_text: string, opts?: { textOnly?: boolean }) => {
        seenOpts = opts;
        return "**Resumen:** la corrida pasó.";
      },
      dispose: async () => {},
    }),
  };
  const answer = await askAssistant({ context: "ctx", question: "¿qué pasó?" }, deps, "/m");
  assert.equal(answer, "**Resumen:** la corrida pasó.");
  assert.equal(seenOpts?.textOnly, true);
});

test("askAssistant opens the requested agent (reflection runs tool-less as qa-reflector; chat is the default)", async () => {
  let openedAgent: string | undefined;
  const deps: AgentDeps = {
    open: async (agent: string) => {
      openedAgent = agent;
      return { id: "s", prompt: async () => "{}", dispose: async () => {} };
    },
  };
  await askAssistant({ context: "c", question: "q", agent: "qa-reflector" }, deps, "/m");
  assert.equal(openedAgent, "qa-reflector");
  await askAssistant({ context: "c", question: "q" }, deps, "/m");
  assert.equal(openedAgent, "qa-assistant"); // default unchanged for the TUI chat path
});



// ── Task 3.11: Prompt-framing tests (Unit 3 — Q2 worker + GROUND TRUTH block + Lever-3 route) ──

test("3.11(a) buildWorkerPrompt with needsUi:true + non-empty domSnapshot does NOT contain browser_navigate or browser_snapshot", () => {
  const w: ParallelWorkerInput = {
    objective: "list owners",
    flow: "owners",
    symbols: [],
    needsUi: true,
    specFile: "flows/owners.spec.ts",
    repo: "r",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    baseUrl: "https://dev",
    appName: "a",
    mode: "complete",
    domSnapshot: "button: Add Owner\ntextbox: First Name",
  };
  const p = buildWorkerPrompt(w);
  assert.doesNotMatch(p, /browser_navigate/);
  assert.doesNotMatch(p, /browser_snapshot/);
  // Must say to use the injected tree (not the live DOM)
  assert.match(p, /GROUND TRUTH/);
  assert.match(p, /You have NO browser/);
  assert.match(p, /do NOT need to navigate/i);
});

test("3.11(a) buildWorkerPrompt with needsUi:true and NO domSnapshot still has no browser_navigate", () => {
  const w: ParallelWorkerInput = {
    objective: "list owners",
    flow: "owners",
    symbols: [],
    needsUi: true,
    specFile: "flows/owners.spec.ts",
    repo: "r",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    baseUrl: "https://dev",
    appName: "a",
    mode: "complete",
  };
  const p = buildWorkerPrompt(w);
  assert.doesNotMatch(p, /browser_navigate/);
  assert.doesNotMatch(p, /browser_snapshot/);
  // Without a domSnapshot, the worker gets a "mark selectors unverified" instruction
  assert.match(p, /unverified/);
});

test("3.11(b) fix-pass prompt with failureSourced:true contains GROUND TRUTH AT FAILURE heading and source-framing", () => {
  const failInput: OpencodeRunInput = {
    ...input,
    domSnapshot: "button: Submit\ntextbox: Email",
    failureSourced: true,
    fixCases: [{ name: "owners list", status: "fail", detail: "expected 'Admin' received 'User'" }],
  };
  const p = buildPrompt(failInput);
  // (1) Heading present
  assert.match(p, /GROUND TRUTH AT FAILURE/);
  // (2) Source-framing: "ONLY source of truth"
  assert.match(p, /ONLY source of truth/);
  // (3) Counterfactual: mentions role convention (columnheader)
  assert.match(p, /columnheader/);
  assert.match(p, /trust the tree/i);
  // (4) Quote-then-assert contract
  assert.match(p, /cite the EXACT/i);
  // (5) Block is at the TOP (before the fix block and the task)
  const domIdx = p.indexOf("GROUND TRUTH AT FAILURE");
  const fixIdx = p.indexOf("Fix failing tests");
  const taskIdx = p.indexOf("Write") > -1 ? p.indexOf("Write") : Infinity;
  assert.ok(domIdx < fixIdx, `GROUND TRUTH block (${domIdx}) must appear before fix block (${fixIdx})`);
  assert.ok(domIdx < taskIdx, `GROUND TRUTH block (${domIdx}) must appear before task (${taskIdx})`);
});

test("3.11(b) fix-pass prompt with failureSourced:true does NOT instruct browser_navigate in the fix block", () => {
  const failInput: OpencodeRunInput = {
    ...input,
    domSnapshot: "button: Submit",
    failureSourced: true,
    fixCases: [{ name: "submit test", status: "fail", detail: "locator not found" }],
  };
  const p = buildPrompt(failInput);
  // With failureSourced, the fix block must NOT say browser_navigate or browser_snapshot.
  assert.doesNotMatch(p, /Use browser_navigate \+ browser_snapshot/);
  // Instead it must reference the GROUND TRUTH tree.
  assert.match(p, /GROUND TRUTH/);
});

test("3.11(b) fix-pass prompt WITHOUT failureSourced retains browser_navigate instruction (non-failure-sourced path)", () => {
  const fixInput: OpencodeRunInput = {
    ...input,
    fixCases: [{ name: "owners list", status: "fail", detail: "locator not found" }],
  };
  const p = buildPrompt(fixInput);
  // Without failureSourced (pre-capture blind fix), the old navigation instructions stay.
  assert.match(p, /browser_navigate/);
  assert.match(p, /browser_snapshot/);
  assert.doesNotMatch(p, /GROUND TRUTH AT FAILURE/);
});

// W1: the Lever-2 selector contradiction must be rendered in FULL, even when the case detail is long
// (a verbose PW 1.60 error). Previously the contradiction was appended to `c.detail` and the fix block
// renders `c.detail?.slice(0, 500)`, so the contradiction was truncated away exactly when an absent
// selector was found. It is now its OWN un-truncated section, threaded via input.selectorContradictions.
test("W1: buildPrompt renders the selector contradiction in FULL even when the case detail is long", () => {
  const longDetail = "Error: expect(locator).toBeVisible() failed\n" + "x".repeat(900); // > 500 chars → detail is sliced
  const contradiction =
    'row: "Bob Smith DISTINCTIVE-MARKER-9f3a" is NOT in the captured failure-point tree. Present roles: button, link, heading, table';
  const failInput: OpencodeRunInput = {
    ...input,
    domSnapshot: "button: Add Owner\nlink: Home\nheading: Find Owners\ntable: (present)",
    failureSourced: true,
    fixCases: [{ name: "owners list", status: "fail", detail: longDetail }],
    selectorContradictions: [contradiction],
  };
  const p = buildPrompt(failInput);
  // The WHOLE contradiction string survives (its distinctive tail is past where a 500-char detail slice ends).
  assert.ok(p.includes(contradiction), "the full contradiction text must be present, un-truncated");
  assert.match(p, /Lever-2 selector contradictions/i);
  assert.match(p, /is NOT in the captured failure-point tree/);
  assert.match(p, /DISTINCTIVE-MARKER-9f3a/);
  // It is NOT folded into the truncated detail: the fix block still slices detail to 500, so the long
  // detail's tail is gone, but the contradiction (its own section) is intact.
  const fixBlockIdx = p.indexOf("Fix failing tests");
  const contradictionIdx = p.indexOf(contradiction);
  assert.ok(contradictionIdx > -1);
  // The contradiction section sits right after the GROUND TRUTH block, before the fix block.
  const groundIdx = p.indexOf("GROUND TRUTH AT FAILURE");
  assert.ok(groundIdx > -1 && groundIdx < contradictionIdx, "contradictions come after the GROUND TRUTH tree");
  assert.ok(contradictionIdx < fixBlockIdx, "contradictions come before the fix-cases block");
});

test("W1: buildPrompt renders MULTIPLE contradictions, each as its own bullet", () => {
  const cs = [
    'textbox: "Owner name" matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)',
    'columnheader: "Name" is NOT in the captured failure-point tree. Present roles: cell, row',
  ];
  const p = buildPrompt({
    ...input,
    failureSourced: true,
    domSnapshot: "cell: x\nrow: y\ntextbox: Owner name\ntextbox: Owner name",
    fixCases: [{ name: "t", status: "fail", detail: "short" }],
    selectorContradictions: cs,
  });
  for (const c of cs) assert.ok(p.includes(c), `missing contradiction: ${c}`);
  assert.match(p, /matches MULTIPLE nodes/);
});

// W1: no contradictions → no contradiction section (clean prompt for the happy path).
test("W1: buildPrompt omits the contradiction section when none are provided", () => {
  const p = buildPrompt({
    ...input,
    failureSourced: true,
    domSnapshot: "button: Submit",
    fixCases: [{ name: "t", status: "fail", detail: "x" }],
  });
  assert.doesNotMatch(p, /Lever-2 selector contradictions/i);
});


test("3.11(d) all existing prompt tests remain green (worker code path unaffected)", () => {
  // Code-only worker (needsUi: false): unchanged behavior, no browser tools ever.
  const codeWorker: ParallelWorkerInput = {
    objective: "test checkout logic",
    flow: "checkout",
    symbols: ["checkout"],
    needsUi: false,
    specFile: "flows/checkout.spec.ts",
    repo: "r",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    appName: "a",
    mode: "complete",
  };
  const p = buildWorkerPrompt(codeWorker);
  assert.doesNotMatch(p, /browser_navigate/);
  assert.doesNotMatch(p, /browser_snapshot/);
  assert.match(p, /CODE-ONLY/);
  assert.match(p, /serena/);
});


// Phase 0b: askAssistant threads the role (and optional runId) into the session descriptor.
// This covers the qa-reflector path used by reflectAndDistill and auditProcess.
test("phase-0b: askAssistant passes role (and optional runId) in the open() descriptor", async () => {
  const capturedDescriptors: Array<{ runId?: string; role?: string }> = [];
  const stub: AgentDeps = {
    open: async (_agent: string, _cwd: string, opts) => {
      capturedDescriptors.push({ runId: opts?.descriptor?.runId, role: opts?.descriptor?.role });
      return {
        id: "s",
        prompt: async () => "answer",
        dispose: async () => {},
      };
    },
  };
  // With runId
  await askAssistant({ context: "ctx", question: "q?", agent: "qa-reflector", runId: "run-reflector-1" }, stub, "/tmp");
  // Without runId (chat path)
  await askAssistant({ context: "ctx", question: "q?" }, stub, "/tmp");
  assert.equal(capturedDescriptors[0]?.role, "qa-reflector", "role forwarded for qa-reflector path");
  assert.equal(capturedDescriptors[0]?.runId, "run-reflector-1", "runId forwarded when provided");
  assert.equal(capturedDescriptors[1]?.role, "qa-assistant", "role forwarded for default chat path");
  assert.equal(capturedDescriptors[1]?.runId, undefined, "runId is undefined when not provided");
});

// ── Phase 1a / Slice D — buildReviewerPrompt (pure builder) ─────────────────
//
// These tests verify that buildReviewerPrompt produces a prompt string with the
// required structural sections (the pure builder extracted from the legacy,
// now-deleted reviewIndependently — see migration-tier-4c Slice 1).

// Helper: a ReviewInput that points at a real spec file on disk.
function makeReviewInput(dir: string, overrides?: Partial<ReviewInput>): ReviewInput {
  return {
    diff: "diff --git a/x b/x\n+const x = 1;",
    specs: ["login.spec.ts"],
    mirrorDir: dir,
    e2eRelDir: "e2e",
    appName: "demo",
    mode: "diff",
    ...overrides,
  };
}

test("Phase 1a D.1: buildReviewerPrompt produces the independence framing and key structural sections (diff mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// login spec\ntest('login', async () => {});");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir));
    // Core independence framing
    assert.match(p, /Independent review/);
    assert.match(p, /WITHOUT the generator's reasoning/i);
    assert.match(p, /no access to the\s+generator's thought process/i);
    // Review context section
    assert.match(p, /## Review context/);
    assert.match(p, /Run type:/);
    // Specs section
    assert.match(p, /## Specs to review/);
    assert.match(p, /login spec/); // the file content is inlined
    // Instructions section
    assert.match(p, /## Instructions/);
    assert.match(p, /STAY IN YOUR LANE/);
    // Verdict JSON contract
    assert.match(p, /\{"approved":false/);
    assert.match(p, /\[fragile-selector\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 1a D.1: buildReviewerPrompt injects the diff as the objective in diff mode (not manual framing)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-diff-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { diff: "DIFF_MARKER_XYZ +const y = 2;" }));
    assert.match(p, /## Commit diff/);
    assert.match(p, /DIFF_MARKER_XYZ/);
    assert.doesNotMatch(p, /## Objective — the requested behavior/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 1a D.1: buildReviewerPrompt uses guidance as the objective in manual mode (not diff)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-manual-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { mode: "manual", guidance: "GUIDANCE_MARKER test the login form" }));
    assert.match(p, /GUIDANCE_MARKER test the login form/);
    assert.match(p, /## Objective — the requested behavior/);
    assert.doesNotMatch(p, /## Commit diff/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 1a D.1: buildReviewerPrompt injects the DOM snapshot when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-dom-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { domSnapshot: "button: Submit\nlink: Register" }));
    assert.match(p, /Live DEV DOM/);
    assert.match(p, /button: Submit/);
    assert.match(p, /link: Register/);
    assert.match(p, /STAY IN YOUR LANE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 1a D.1: buildReviewerPrompt omits the DOM section when no snapshot is provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-nodom-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir));
    assert.doesNotMatch(p, /Live DEV DOM/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Phase 1b deixis guard (regression for the stale "above" wording): the canonical reorder places the
// ## Instructions section BEFORE the spec contents and the Live DEV DOM, so any instruction that
// claims either is "above" is FALSE. Assert the instructions are position-independent AND that the
// real section order matches the wording (Instructions precede both specs and DOM).
test("Phase 1b: reviewer Instructions are position-independent and precede the specs/DOM they reference", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-deixis-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// SPEC_BODY_MARKER\ntest('x', async () => {});");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { domSnapshot: "button: Submit", learnedRules: "- avoid waitForTimeout" }));

    // Isolate the Instructions section (up to the next "## " heading) so a legitimate "above" in a
    // later section (e.g. spec contents referencing the DOM) cannot mask a stale instruction.
    const instrStart = p.indexOf("## Instructions");
    assert.ok(instrStart >= 0, "Instructions section must be present");
    const afterInstr = p.slice(instrStart + "## Instructions".length);
    const nextHeading = afterInstr.indexOf("\n## ");
    const instructions = nextHeading >= 0 ? afterInstr.slice(0, nextHeading) : afterInstr;
    assert.doesNotMatch(
      instructions,
      /\babove\b/i,
      "no reviewer instruction may claim content is 'above' (canonical order puts Instructions BEFORE specs/DOM)",
    );

    // The wording the fix uses is present and position-neutral.
    assert.match(p, /spec contents are provided in this prompt/i);
    assert.match(p, /Live DEV DOM section/);

    // The structural order matches the wording: Instructions BEFORE the DOM and BEFORE the specs.
    const domIdx = p.indexOf("## Live DEV DOM");
    const specsIdx = p.indexOf("## Specs to review");
    assert.ok(domIdx > instrStart, "Live DEV DOM must appear AFTER the Instructions section");
    assert.ok(specsIdx > instrStart, "Specs must appear AFTER the Instructions section");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 1a D.1: buildReviewerPrompt injects learnedRules when present and adds the extra rule instruction", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prompt-rules-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { learnedRules: "- RULE_MARKER avoid waitForTimeout" }));
    assert.match(p, /RULE_MARKER avoid waitForTimeout/);
    assert.match(p, /6\. Also REJECT/);
    assert.doesNotMatch(buildReviewerPrompt(makeReviewInput(dir)), /6\. Also REJECT/, "no extra instruction without rules");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── Phase 4: severity gate + stateful rounds — buildReviewerPrompt ────────────

test("Phase 4: buildReviewerPrompt includes severity instructions in the output contract", () => {
  // The output contract section must explain the blocking/advisory severity field so the
  // reviewer knows to emit structured correction objects.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-severity-contract-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir));
    assert.match(p, /severity/, "output contract must mention severity field");
    assert.match(p, /blocking/, "output contract must explain blocking severity");
    assert.match(p, /advisory/, "output contract must explain advisory severity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: buildReviewerPrompt without priorCorrections omits the prior-corrections section", () => {
  // On round 1, there are no prior corrections to inject — the section must be absent.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-no-prior-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir)); // no priorCorrections
    assert.doesNotMatch(p, /Prior-round corrections/, "no prior-corrections section on round 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4 (d): buildReviewerPrompt injects priorCorrections as a VOLATILE section on round 2+", () => {
  // On round 2, the reviewer must receive its own round-1 corrections so it can converge.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prior-round-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  const priorCorrections = [
    "[false-positive] login.spec.ts: PRIOR_BLOCKING_CORRECTION — add assertion",
  ];
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { priorCorrections }));
    assert.match(p, /Prior-round corrections/, "prior-corrections section must appear");
    assert.match(p, /PRIOR_BLOCKING_CORRECTION/, "the actual correction text must be injected");
    assert.match(p, /approve.*blocking.*resolved/i, "convergence instruction must be present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: buildReviewerPrompt prior-corrections section appears AFTER specs in the assembled order", () => {
  // The prior-corrections section is in the VOLATILE band at priority 4 (after specs at priority 2).
  // This ensures it never crowds out the primary spec contents the reviewer is judging.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-prior-order-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "spec.spec.ts"), "// SPEC_CONTENT_MARKER");
  const priorCorrections = ["[other] spec.spec.ts: PRIOR_CORRECTION_MARKER"];
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, { specs: ["spec.spec.ts"], priorCorrections }));
    const specIdx = p.indexOf("SPEC_CONTENT_MARKER");
    const priorIdx = p.indexOf("PRIOR_CORRECTION_MARKER");
    assert.ok(specIdx !== -1 && priorIdx !== -1, "both markers must appear in the prompt");
    assert.ok(specIdx < priorIdx, "spec content must appear BEFORE prior corrections");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4 regression: complete/exhaustive buildReviewerPrompt works unchanged (no priorCorrections by default)", () => {
  // complete/exhaustive runs call buildReviewerPrompt with mode="complete" and no priorCorrections.
  // The existing behavior must be preserved: no prior-corrections section, no regressions.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-complete-reg-"));
  mkdirSync(join(dir, "e2e", "flows"), { recursive: true });
  writeFileSync(join(dir, "e2e", "flows", "complete.spec.ts"), "// COMPLETE_SPEC_MARKER");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir, {
      mode: "complete",
      specs: ["flows/complete.spec.ts"],
      guidance: undefined,
    }));
    assert.doesNotMatch(p, /Prior-round corrections/, "no prior corrections on first complete/exhaustive round");
    assert.match(p, /COMPLETE_SPEC_MARKER/, "spec content inlined");
    // The whole-repo objective framing must appear (not the commit-diff framing).
    assert.match(p, /whole-repo complete run/, "complete mode uses whole-repo objective framing");
    // Severity contract must appear (Phase 4 — both complete and diff share the reviewer role).
    assert.match(p, /blocking/, "severity blocking instruction in contract");
    assert.match(p, /advisory/, "severity advisory instruction in contract");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Slice F Phase 2: budget wiring end-to-end through the *Assembled builders ─
//
// The budget engine (model-window-catalog + assemble budgetBytes) is INERT unless
// the *Assembled builders resolve the per-role window and pass it as budgetBytes.
// These tests prove the wiring is active and can never silently regress to inert again.

test("Slice F F.3: buildPromptAssembled applies qa-generator budget — normal prompt fits, no sections shed", () => {
  // A minimal diff-mode prompt is well within the qa-generator budget
  // (roleWindowBytes("qa-generator") = floor(64000 × 0.75 × 4) = 192,000 bytes).
  // All sections must survive when the prompt is normal-sized.
  const { text, sectionSizes } = buildPromptAssembled({
    ...input,
    mode: "diff",
    diff: "diff --git a/x b/x\n+const x = 1;",
  });

  // Core sections must all survive (nothing shed by the conservative budget).
  assert.match(text, /Working rules/, "working-rules section must survive");
  assert.match(text, /Generate\/update E2E tests/, "task section must survive");

  // sectionSizes must exist for the core sections.
  assert.ok("working-rules" in sectionSizes, "working-rules in sectionSizes");
  assert.ok("task" in sectionSizes, "task in sectionSizes");

  // The total byte size must be well under the qa-generator budget (192,000 bytes).
  const totalBytes = Buffer.byteLength(text, "utf8");
  const budget = roleWindowBytes("qa-generator");
  assert.ok(budget > 0, "roleWindowBytes must return a positive budget");
  assert.ok(
    totalBytes < budget,
    `normal prompt (${totalBytes} bytes) must fit within qa-generator budget (${budget} bytes)`,
  );
});

test("Slice F F.3: buildReviewerPromptAssembled applies qa-reviewer budget — oversized learnedRules section is shed", () => {
  // The qa-reviewer budget = floor(32000 × 0.75 × 4) = 96,000 bytes.
  // To force an overflow: pad learnedRules to exceed the budget when combined with
  // the other sections (role-framing + instructions + objective + specs + output-contract
  // together are ~4–6 KB; so learnedRules > 92 KB reliably overflows the 96 KB budget).
  // reviewer-learned-rules has priority: 3 within volatile (the lowest-priority volatile
  // section in the reviewer), so it is shed FIRST by the global budget pass.
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-budget-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec\ntest('login', async () => {});");

  // A learnedRules string that is guaranteed to push the total over the budget.
  // reviewer budget = 96,000 bytes; 100,000 bytes of learnedRules is safely over.
  const hugeLearnedRules = "- rule: " + "x".repeat(100_000);

  try {
    const { text, sectionSizes } = buildReviewerPromptAssembled(
      makeReviewInput(dir, { learnedRules: hugeLearnedRules }),
    );

    // The oversized learnedRules section must be shed (overflow='drop' for a section
    // that pushes the total over budget; reviewer-learned-rules is the lowest-priority
    // volatile section and therefore the first candidate to go).
    assert.ok(
      !text.includes(hugeLearnedRules.slice(0, 20)),
      "oversized learnedRules section must be shed when budget is exceeded",
    );

    // The reviewer budget IS applied: without it, hugeLearnedRules would appear in the prompt.
    // Core load-bearing sections must survive (they have the highest shed-resistance).
    assert.match(text, /Independent review/, "role-framing section must survive");
    assert.match(text, /\{"approved":false/, "output-contract section must survive");

    // sectionSizes must NOT include the shed section (dropped sections are excluded).
    assert.ok(
      !("reviewer-learned-rules" in sectionSizes),
      "shed section must not appear in sectionSizes",
    );

    // The surviving prompt must fit within the budget.
    const totalBytes = Buffer.byteLength(text, "utf8");
    const budget = roleWindowBytes("qa-reviewer");
    assert.ok(budget > 0, "roleWindowBytes must return a positive budget");
    assert.ok(
      totalBytes <= budget,
      `surviving prompt (${totalBytes} bytes) must be within qa-reviewer budget (${budget} bytes)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T8: renderExecutionResult + ReviewInput.executionResult ──────────────────
//
// These tests drive the T8 reviewer-consumer chain:
//   - renderExecutionResult is a pure renderer: sanitizes finalUrl, bounds total
//     output at 4000 chars, caps per-case detail at 500 chars.
//   - ReviewInput gains an optional executionResult field.
//   - buildReviewerPromptAssembled emits a VOLATILE "RUNTIME EXECUTION RESULT"
//     section when executionResult is present, and omits it when absent.
//
// Tests are written BEFORE implementation (STRICT TDD / RED phase).

test("T8 R1: renderExecutionResult is exported from opencode-client", () => {
  // The function must exist and be callable as a named export.
  assert.strictEqual(typeof renderExecutionResult, "function");
});

test("T8 R2: renderExecutionResult returns a non-empty string with the authoritative heading", () => {
  const result = renderExecutionResult({
    verdict: "fail",
    cases: [{ name: "login test", httpStatus: 500, finalUrl: "https://app.example.com/login" }],
  });
  assert.strictEqual(typeof result, "string");
  assert.match(result, /RUNTIME EXECUTION RESULT/i, "heading must mention RUNTIME EXECUTION RESULT");
  assert.match(result, /authoritative/i, "heading must be marked as authoritative");
});

test("T8 R3: renderExecutionResult sanitizes finalUrl (strips token query param)", () => {
  const result = renderExecutionResult({
    verdict: "fail",
    cases: [
      {
        name: "auth test",
        httpStatus: 500,
        finalUrl: "https://app.example.com/callback?token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ],
  });
  assert.doesNotMatch(result, /ghp_AAAA/, "finalUrl token must be redacted before reaching the reviewer");
});

test("T8 R4: renderExecutionResult total output is bounded at 4000 chars", () => {
  // Generate a case with very long detail to trigger the cap.
  const cases = Array.from({ length: 20 }, (_, i) => ({
    name: `test ${i}`,
    detail: "x".repeat(1000),
    httpStatus: 500,
    finalUrl: `https://app.example.com/page${i}`,
  }));
  const result = renderExecutionResult({ verdict: "fail", cases });
  assert.ok(result.length <= 4000, `total output must be <= 4000 chars, got ${result.length}`);
});

test("T8 R5: renderExecutionResult caps per-case detail at 500 chars", () => {
  const longDetail = "z".repeat(1000);
  const result = renderExecutionResult({
    verdict: "fail",
    cases: [{ name: "verbose test", detail: longDetail }],
  });
  // The long detail must be truncated — the result cannot contain 600 consecutive z's.
  assert.doesNotMatch(
    result,
    /z{600}/,
    "per-case detail must be capped at 500 chars",
  );
});

test("T8 R6: buildReviewerPrompt omits execution-result section when executionResult is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-no-execresult-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const p = buildReviewerPrompt(makeReviewInput(dir)); // no executionResult
    assert.doesNotMatch(p, /RUNTIME EXECUTION RESULT/i, "no execution-result section when field is absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T8 R7: buildReviewerPrompt injects execution-result section when executionResult is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-execresult-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const executionResult = renderExecutionResult({
      verdict: "fail",
      cases: [{ name: "login", httpStatus: 500, finalUrl: "https://app.example.com/login" }],
    });
    const p = buildReviewerPrompt(makeReviewInput(dir, { executionResult }));
    assert.match(p, /RUNTIME EXECUTION RESULT/i, "execution-result section must appear when field is set");
    assert.match(p, /authoritative/i, "section heading must include the authoritative qualifier");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T8 R8: buildReviewerPrompt execution-result section is VOLATILE (precedes output contract)", () => {
  // The execution-result section is VOLATILE evidence — it must appear BEFORE the
  // CRITICAL-recap output contract so the contract is always last (as the assembler guarantees).
  const dir = mkdtempSync(join(tmpdir(), "qa-rev-execresult-order-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "login.spec.ts"), "// spec");
  try {
    const executionResult = renderExecutionResult({
      verdict: "fail",
      cases: [{ name: "login", httpStatus: 500 }],
    });
    const p = buildReviewerPrompt(makeReviewInput(dir, { executionResult }));
    const execIdx = p.indexOf("RUNTIME EXECUTION RESULT");
    const contractIdx = p.indexOf('{"approved":false');
    assert.ok(execIdx >= 0, "execution-result section must be present");
    assert.ok(contractIdx >= 0, "output contract must be present");
    assert.ok(
      execIdx < contractIdx,
      "execution-result section must appear BEFORE the output contract",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


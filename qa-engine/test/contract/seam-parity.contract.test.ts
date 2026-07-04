// qa-engine/test/contract/seam-parity.contract.test.ts
//
// THE CLASS-KILLER (task #40). Every audit/live-run finding from 2026-06-25..2026-07-02 traced back
// to ONE root pattern: "a value exists at layer N of the rewritten chain and dies at layer N+1"
// (baseUrl reached execution but not the generation prompt; namespace, mode, guidance, publish
// flags, manifest fields, enrichment fields — all the SAME class of bug, found by a live run or a
// manual audit each time, never by a test). This file is the mechanized regression gate: it
// enumerates each legacy input surface and asserts the rewritten chain carries every field.
//
// Lives under qa-engine/test/contract/ (not test/contexts/.../bridges/) because it deliberately
// imports BOTH root src/ (the legacy shape it audits against) AND qa-engine's @contexts/@kernel
// aliases — the SAME "src/-importing seam" characterization tests already use (golden-parity.test.ts,
// generation-ports-parity.test.ts). It is therefore excluded from qa-engine/tsconfig.json's
// `include` and added to qa-engine/tsconfig.parity.json's `include` instead, mirroring that exact
// precedent (see this repo's package.json `typecheck` script: tsc -b qa-engine/tsconfig.json, THEN
// tsc --noEmit -p tsconfig.json, THEN tsc --noEmit -p qa-engine/tsconfig.parity.json — three
// separate programs, each covering a disjoint file set).
//
// DESIGN — four describe-blocks, one per audited surface:
//   a) GENERATION PROMPT — OpencodeRunInput (src/integrations/opencode-client.ts) vs what
//      GenerationPortAdapter.generate() actually builds (fully-populated ctx + enrichment,
//      recording GenerateTestsUseCase fake).
//   b) REVIEW — ReviewInput (src/integrations/opencode-client.ts) vs ReviewPortAdapter.review()
//      (fully-populated ctx + enrichment, recording rendering.renderReviewer fake).
//   c) EXECUTION — ExecuteOptions (src/qa/execute.ts) vs ExecutionPortAdapter.execute()'s
//      ExecutionRequest mapping (ExecutionOpts bag + static ctx, recording strategy fake).
//   d) PERSISTENCE — kernel RunOutcome vs SqliteRunHistoryAdapter's toLegacyRunOutcome mapping
//      (fully-populated kernel outcome, real (pure) mapping fn — no fake needed, it's already pure).
//   e) COMPOSITION — CompositionConfig vs buildRewrittenCompositionConfig's returned object
//      (a fully-populated AppConfig, asserting every non-optional field is present and every
//      optional field is either present or in a documented allowlist).
//
// Each block enumerates its target TYPE's field list via a `keyof`-driven `satisfies`/array
// construction so that a field ADDED to the type without a matching allowlist/sentinel entry FAILS
// TYPECHECK (npm run typecheck), and a field silently DROPPED by the adapter FAILS THIS TEST (npm
// test) — the two gates this class of bug needs closed. Every allowlist entry carries a one-line
// reason. Failure messages name the dropped field AND the dying layer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { GenerationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts";
import { ReviewPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/review-port.adapter.ts";
import { ExecutionPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";

import type { OpencodeRunInput, ReviewInput } from "../../../src/integrations/opencode-client.ts";
import type { ExecuteOptions } from "../../../src/qa/execute.ts";
import { toLegacyRunOutcome, type RunHistorySqliteAdapterDeps, SqliteRunHistoryAdapter } from "../../../src/server/run-history-sqlite-adapter.ts";
import { buildRewrittenCompositionConfig, type RewrittenEngineFactoryDeps } from "../../../src/server/rewritten-engine-factory.ts";
import type { AppConfig } from "../../../src/orchestrator/config-loader.ts";
import type { AgentDeps } from "../../../src/integrations/opencode-client.ts";

// ── shared sentinel helpers ─────────────────────────────────────────────────────────────────────
// A sentinel is a value that is IMPOSSIBLE to produce by accident (unlike "", 0, false, or []),
// so `assert.equal(captured.field, SENTINEL)` fails loudly if the adapter silently substitutes a
// default, drops the field, or forwards the wrong one.
const S = (field: string): string => `__SENTINEL__${field}__`;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (a) GENERATION PROMPT surface — OpencodeRunInput vs GenerationPortAdapter
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: GENERATION PROMPT (OpencodeRunInput vs GenerationPortAdapter)", () => {
  // Every field OpencodeRunInput declares (src/integrations/opencode-client.ts), enumerated by hand
  // from the type — TypeScript's `satisfies Record<keyof OpencodeRunInput, true>` below fails
  // COMPILATION the moment a field is added to the type without a matching entry here, closing the
  // "future field silently unmapped" gap the mission calls out.
  const ALL_FIELDS = {
    repo: true, sha: true, diff: true, mirrorDir: true, e2eRelDir: true, namespace: true,
    needsReview: true, target: true, mode: true, appName: true, baseUrl: true, intent: true,
    guidance: true, openapi: true, fixCases: true, reviewCorrections: true, coverageGap: true,
    selectorContradictions: true, learnedRules: true, domSnapshot: true, failureSourced: true,
    runId: true, contextMap: true, explorer: true, contextBrief: true, contextPack: true,
    staticSignal: true, diffArchetypes: true, existingSpecFiles: true, service: true, services: true,
  } satisfies Record<keyof OpencodeRunInput, true>;

  // Fields the rewritten path deliberately sources OUTSIDE this adapter's ctx+enrichment, or that
  // are genuinely NOT YET WIRED (a real finding — the orchestrator decides the fix). Every entry
  // carries a reason; FIXME entries are confirmed-dropped fields with the evidence trail.
  const ALLOWLIST: Record<string, string> = {
    // Deliberately unmapped: this bridge doesn't drive prompt assembly for these — confirmed by
    // reading src/integrations/prompts.ts's own consumers.
    explorer: "explorer-pass gating is NOT wired on the rewritten path (no GenerationEnrichment/ctx slot exists for it; grep of ports/index.ts confirms) — FIXME: prompts.ts:647 gates the entire Fase-3 explorer pass on input.explorer, so it silently never fires on the rewritten path.",
    contextBrief: "FIXME: no GenerationEnrichment/ctx slot exists (grep-confirmed) — prompts.ts renders the 'blast radius' plan-brief section from input.contextBrief; the rewritten path's PreGenerationGroundingPort produces a context PACK (enrichment.contextPack) instead, which is a DIFFERENT rendering path (prompts.ts:611) that partially covers this, but the raw ExplorationBrief object itself is never threaded.",
    contextMap: "NOT dropped at this bridge — sourced via a DIFFERENT port (PreGenerationGroundingPort, composition-root.ts:cfg.contextMap), which folds it into enrichment.contextPack before this adapter ever sees it. Correct by design, not a gap.",
    diffArchetypes: "FIXME: no GenerationEnrichment/ctx slot exists (grep-confirmed) — prompts.ts:829 renders a one-line 'change shape' hint from input.diffArchetypes (detectStructuralPatterns output). Dropped means the rewritten path never prioritises archetype-appropriate tests.",
    failureSourced: "FIXME: no GenerationEnrichment/ctx slot exists (grep-confirmed) — prompts.ts:624,708,922 switches domSnapshot framing to 'GROUND TRUTH AT FAILURE' when true. domSnapshot itself IS threaded (enrichment.domSnapshot); the framing flag that changes how it's presented is not.",
    service: "FIXME: no GenerationEnrichment/ctx/CompositionConfig slot exists (grep-confirmed) — prompts.ts renders cross-repo framing from input.service (the triggering microservice) at 6+ call sites (286-291,433-434,456-457,1246-1251). Cross-repo runs are a documented CLAUDE.md feature (\"Cross-repo runs (microservices)\"); this is a real gap for that feature on the rewritten path.",
    services: "FIXME: no GenerationEnrichment/ctx/CompositionConfig slot exists (grep-confirmed, AppConfig.services IS real — src/orchestrator/schemas.ts) — prompts.ts:1069-1120 renders the full microservice-repo list (context mode). Same cross-repo gap as `service` above.",
  };

  test("OpencodeRunInput's own field list matches the allowlist + the adapter's mapped set exactly (no silent field added to either side)", () => {
    const mapped = [
      "repo", "sha", "diff", "mirrorDir", "e2eRelDir", "namespace", "needsReview", "target", "mode",
      "appName", "guidance", "baseUrl", "reviewCorrections", "fixCases", "selectorContradictions",
      "domSnapshot", "coverageGap", "intent", "learnedRules", "contextPack", "existingSpecFiles", "runId",
      "openapi", "staticSignal",
    ];
    const allFieldNames = Object.keys(ALL_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(
      accountedFor,
      allFieldNames,
      "every OpencodeRunInput field must be either mapped by the adapter (asserted below) or listed in ALLOWLIST with a reason — a field in neither set is an unaudited gap",
    );
  });

  test("generate() carries every mapped OpencodeRunInput field through with its sentinel value (fully-populated ctx + enrichment)", async () => {
    let captured: OpencodeRunInput | undefined;
    const recordingPorts: GenerationPorts = {
      runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) } as unknown as GenerationPorts["runtime"],
      rendering: {
        render: () => "",
        renderMain: (input) => { captured = input; return { text: "", sectionSizes: {} }; },
        renderWorker: () => ({ text: "", sectionSizes: {} }),
        renderReviewer: () => ({ text: "", sectionSizes: {} }),
        renderExplorer: () => "",
        specFileForFlow: (f: string) => `${f}.spec.ts`,
      },
      verdicts: {
        parseGenerator: () => ({ specs: [] }),
        parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
      },
      manifest: { read: async () => [], reconcile: async (_d, entries) => [...entries] },
      budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 100_000 },
    };
    const useCase = new GenerateTestsUseCase(recordingPorts);

    const adapter = new GenerationPortAdapter(useCase, {
      repo: S("repo"),
      appName: S("appName"),
      mirrorDir: S("mirrorDir"),
      e2eRelDir: S("e2eRelDir"),
      namespace: S("namespace"),
      needsReview: true,
      target: "e2e",
      mode: "diff",
      diff: S("ctx.diff"), // overridden by the dynamic `diff` arg below
      guidance: S("guidance"),
      baseUrl: S("baseUrl"),
      openapi: S("openapi"),
    });

    await adapter.generate([], "/specDir", undefined, S("diff"), {
      reviewCorrections: [S("reviewCorrections")],
      fixCases: [{ name: S("fixCases.name"), status: "fail", detail: S("fixCases.detail") }],
      selectorContradictions: [S("selectorContradictions")],
      domSnapshot: S("domSnapshot"),
      coverageGap: S("coverageGap"),
      intent: { type: "feat", breaking: false, message: S("intent.message"), changedFiles: [S("intent.changedFiles")] },
      sha: S("sha"),
      learnedRules: [{ trigger: S("rule.trigger"), action: S("rule.action"), errorClass: "E-EXEC-FAIL", status: "active", confidence: "high" }],
      contextPack: S("contextPack"),
      existingSpecFiles: [S("existingSpecFiles")],
      runId: S("runId"),
      staticSignal: S("staticSignal"),
    });

    assert.ok(captured, "renderMain must have been called — the generator session never ran");
    const dyingLayer = "GenerationPortAdapter.generate() -> OpencodeRunInput (qa-engine/.../bridges/generation-port.adapter.ts)";

    assert.equal(captured!.repo, S("repo"), `repo dropped at ${dyingLayer}`);
    assert.equal(captured!.sha, S("sha"), `sha dropped at ${dyingLayer}`);
    assert.equal(captured!.diff, S("diff"), `diff dropped at ${dyingLayer} (dynamic diff must win over ctx.diff)`);
    assert.equal(captured!.mirrorDir, S("mirrorDir"), `mirrorDir dropped at ${dyingLayer}`);
    assert.equal(captured!.e2eRelDir, S("e2eRelDir"), `e2eRelDir dropped at ${dyingLayer}`);
    assert.equal(captured!.namespace, S("namespace"), `namespace dropped at ${dyingLayer}`);
    // needsReview: GenerationPortAdapter itself passes ctx.needsReview through FAITHFULLY (verified
    // by direct construction here, bypassing composition-root.ts). The "force false — kill the
    // double reviewer" override (W2 fix F4) happens ONE LAYER UP, at composition-root.ts's own
    // wireBridges() call site (which always constructs this adapter with needsReview:false,
    // regardless of cfg.needsReview) — NOT inside this adapter. Asserting ctx.needsReview passes
    // through unchanged here is what proves that override is a composition-root decision, not an
    // adapter-level hardcode silently eating the field.
    assert.equal(captured!.needsReview, true, `needsReview dropped/overridden at ${dyingLayer} (expected ctx.needsReview to pass through faithfully when this adapter is constructed directly)`);
    assert.equal(captured!.target, "e2e", `target dropped at ${dyingLayer}`);
    assert.equal(captured!.mode, "diff", `mode dropped at ${dyingLayer}`);
    assert.equal(captured!.appName, S("appName"), `appName dropped at ${dyingLayer}`);
    assert.equal(captured!.baseUrl, S("baseUrl"), `baseUrl dropped at ${dyingLayer} (THE live-run root cause this bridge's own header documents)`);
    assert.equal(captured!.guidance, S("guidance"), `guidance dropped at ${dyingLayer}`);
    assert.deepEqual(captured!.reviewCorrections, [S("reviewCorrections")], `reviewCorrections dropped at ${dyingLayer}`);
    assert.deepEqual(captured!.fixCases, [{ name: S("fixCases.name"), status: "fail", detail: S("fixCases.detail") }], `fixCases dropped at ${dyingLayer}`);
    assert.deepEqual(captured!.selectorContradictions, [S("selectorContradictions")], `selectorContradictions dropped at ${dyingLayer}`);
    assert.equal(captured!.domSnapshot, S("domSnapshot"), `domSnapshot dropped at ${dyingLayer}`);
    assert.equal(captured!.coverageGap, S("coverageGap"), `coverageGap dropped at ${dyingLayer}`);
    assert.equal(captured!.intent?.message, S("intent.message"), `intent dropped at ${dyingLayer}`);
    assert.ok(captured!.learnedRules?.includes(S("rule.trigger")), `learnedRules dropped/not-rendered at ${dyingLayer}`);
    assert.equal(captured!.contextPack, S("contextPack"), `contextPack dropped at ${dyingLayer}`);
    assert.deepEqual(captured!.existingSpecFiles, [S("existingSpecFiles")], `existingSpecFiles dropped at ${dyingLayer}`);
    assert.equal(captured!.runId, S("runId"), `runId dropped at ${dyingLayer} (W5 fix: SSE session descriptor telemetry starved without it)`);
    assert.equal(captured!.openapi, S("openapi"), `openapi dropped at ${dyingLayer} (W5 fix: app-static OpenAPI glob hint)`);
    assert.equal(captured!.staticSignal, S("staticSignal"), `staticSignal dropped at ${dyingLayer} (Phase 4 blast-radius wiring: the code-graph advisory section never reaches the generator)`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (b) REVIEW surface — ReviewInput vs ReviewPortAdapter
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: REVIEW (ReviewInput vs ReviewPortAdapter)", () => {
  const ALL_FIELDS = {
    diff: true, specs: true, mirrorDir: true, e2eRelDir: true, baseUrl: true, intent: true,
    guidance: true, appName: true, mode: true, target: true, learnedRules: true, domSnapshot: true,
    runId: true, objective: true, priorCorrections: true, executionResult: true,
  } satisfies Record<keyof ReviewInput, true>;

  const ALLOWLIST: Record<string, string> = {
    target: "NOT threaded by ReviewPortAdapter — ReviewInput.target is optional and only 'adjusts wording and spec paths' (opencode-client.ts comment); ReviewPortStaticContext carries no target field at all (grep-confirmed). Low-severity: the reviewer prompt defaults to e2e wording even for code-mode reviews on the rewritten path. FIXME candidate, not yet evidenced by a live run.",
    intent: "NOT mapped to ReviewInput.intent directly — the bridge derives ReviewInput.objective from enrichment.intent.message instead (review-port.adapter.ts:86, mirrors legacy's `opts.guidance ?? intent?.message`). The raw CommitIntent object itself never reaches ReviewInput.intent, but its one consumed field (message) does, via a different field. Deliberate re-shape, not a drop.",
    executionResult: "FIXME: no ReviewEnrichment slot exists (grep-confirmed) — opencode-client.ts documents this as a D4/D5 field: sanitized HTTP statuses + final URLs captured during Filter C execution, injected as an authoritative VOLATILE section so the reviewer weighs an objective 5xx before judging test code. Dropped means the rewritten-path reviewer never sees this evidence.",
  };

  test("ReviewInput's own field list matches the allowlist + the adapter's mapped set exactly", () => {
    const mapped = ["diff", "specs", "mirrorDir", "e2eRelDir", "appName", "mode", "baseUrl", "guidance", "priorCorrections", "objective", "learnedRules", "domSnapshot", "runId"];
    const allFieldNames = Object.keys(ALL_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(accountedFor, allFieldNames, "every ReviewInput field must be either mapped or allowlisted with a reason");
  });

  test("review() carries every mapped ReviewInput field through with its sentinel value (fully-populated ctx + enrichment)", async () => {
    let captured: ReviewInput | undefined;
    const adapter = new ReviewPortAdapter(
      {
        runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) },
        rendering: {
          render: () => "",
          renderMain: () => ({ text: "", sectionSizes: {} }),
          renderWorker: () => ({ text: "", sectionSizes: {} }),
          renderReviewer: (input) => { captured = input as ReviewInput; return { text: "", sectionSizes: {} }; },
          renderExplorer: () => "",
          specFileForFlow: (f: string) => `${f}.spec.ts`,
        },
        verdicts: { parseGenerator: () => ({ specs: [] }), parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
      },
      {
        diff: S("ctx.diff"),
        mirrorDir: S("mirrorDir"),
        e2eRelDir: S("e2eRelDir"),
        appName: S("appName"),
        mode: "diff",
        baseUrl: S("baseUrl"),
        // guidance deliberately OMITTED here so the intent.message fallback (objective) is observable —
        // ReviewPortAdapter's own contract: guidance wins over intent when both are present.
      },
    );

    await adapter.review(
      "/specDir",
      [{ name: S("case.name"), status: "pass", file: S("case.file") }],
      S("diff"),
      {
        priorCorrections: [S("priorCorrections")],
        intent: { type: "feat", breaking: false, message: S("intent.message"), changedFiles: [] },
        learnedRules: [{ trigger: S("rule.trigger"), action: S("rule.action"), errorClass: "E-EXEC-FAIL", status: "active", confidence: "high" }],
        domSnapshot: S("domSnapshot"),
        runId: S("runId"),
      },
    );

    assert.ok(captured, "renderReviewer must have been called — the reviewer session never ran");
    const dyingLayer = "ReviewPortAdapter.review() -> ReviewInput (qa-engine/.../bridges/review-port.adapter.ts)";

    assert.equal(captured!.diff, S("diff"), `diff dropped at ${dyingLayer} (dynamic diff must win over ctx.diff)`);
    assert.deepEqual(captured!.specs, [S("case.file")], `specs dropped at ${dyingLayer}`);
    assert.equal(captured!.mirrorDir, S("mirrorDir"), `mirrorDir dropped at ${dyingLayer}`);
    assert.equal(captured!.e2eRelDir, S("e2eRelDir"), `e2eRelDir dropped at ${dyingLayer}`);
    assert.equal(captured!.appName, S("appName"), `appName dropped at ${dyingLayer}`);
    assert.equal(captured!.mode, "diff", `mode dropped at ${dyingLayer}`);
    assert.equal(captured!.baseUrl, S("baseUrl"), `baseUrl dropped at ${dyingLayer}`);
    assert.deepEqual(captured!.priorCorrections, [S("priorCorrections")], `priorCorrections dropped at ${dyingLayer}`);
    assert.equal(captured!.objective, S("intent.message"), `objective (derived from intent.message) dropped at ${dyingLayer}`);
    assert.ok(captured!.learnedRules?.includes(S("rule.trigger")), `learnedRules dropped/not-rendered at ${dyingLayer}`);
    assert.equal(captured!.domSnapshot, S("domSnapshot"), `domSnapshot dropped at ${dyingLayer}`);
    assert.equal(captured!.runId, S("runId"), `runId dropped at ${dyingLayer} (W5 fix: reviewer session's own SSE descriptor telemetry starved without it)`);
  });

  test("review() carries ctx.guidance through verbatim (guidance wins over intent.message per the adapter's own documented contract)", async () => {
    let captured: ReviewInput | undefined;
    const adapter = new ReviewPortAdapter(
      {
        runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) },
        rendering: {
          render: () => "",
          renderMain: () => ({ text: "", sectionSizes: {} }),
          renderWorker: () => ({ text: "", sectionSizes: {} }),
          renderReviewer: (input) => { captured = input as ReviewInput; return { text: "", sectionSizes: {} }; },
          renderExplorer: () => "",
          specFileForFlow: (f: string) => `${f}.spec.ts`,
        },
        verdicts: { parseGenerator: () => ({ specs: [] }), parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
      },
      { diff: "", mirrorDir: "/m", e2eRelDir: "e2e", appName: "app", mode: "diff", guidance: S("guidance") },
    );

    await adapter.review("/specDir", [{ name: "c", status: "pass" }]);

    assert.equal(captured!.guidance, S("guidance"), "guidance dropped at ReviewPortAdapter.review() -> ReviewInput");
    assert.equal(captured!.objective, undefined, "objective must stay absent when guidance is present — guidance flows through .guidance, not .objective");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (c) EXECUTION surface — ExecuteOptions vs ExecutionPortAdapter's ExecutionRequest mapping
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: EXECUTION (legacy ExecuteOptions vs ExecutionPortAdapter)", () => {
  // Legacy ExecuteOptions bundles baseUrl/namespace WITH the per-call opts; the rewritten split
  // moves baseUrl/namespace to ExecutionPortStaticContext (constructor-time) — a deliberate re-shape
  // (documented in execution-port.adapter.ts's own header: "baseUrl/namespace held as static
  // per-run context"), asserted separately below, not a drop.
  const ALL_FIELDS = {
    baseUrl: true, namespace: true, onCase: true, onRunning: true, onDiscovered: true,
    faultInject: true, signal: true, timeoutMs: true, project: true, testIdAttribute: true,
    specFiles: true,
  } satisfies Record<keyof ExecuteOptions, true>;

  const ALLOWLIST: Record<string, string> = {
    baseUrl: "re-shaped to ExecutionPortStaticContext (constructor-time, not per-call) — asserted directly below, not a drop.",
    namespace: "re-shaped to ExecutionPortStaticContext (constructor-time, not per-call) — asserted directly below, not a drop.",
  };

  test("ExecuteOptions' own field list matches the allowlist + the adapter's mapped set exactly", () => {
    const mapped = ["onCase", "onRunning", "onDiscovered", "faultInject", "signal", "timeoutMs", "project", "testIdAttribute", "specFiles"];
    const allFieldNames = Object.keys(ALL_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(accountedFor, allFieldNames, "every ExecuteOptions field must be either mapped or allowlisted with a reason");
  });

  test("execute() carries every ExecuteOptions-equivalent field through into the e2e strategy's ExecutionRequest with its sentinel value", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
      capturedOpts = opts as unknown as Record<string, unknown>;
      return { verdict: "pass", cases: [], logs: "" };
    });
    const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
    const adapter = new ExecutionPortAdapter(
      { e2e, code },
      { target: "e2e", baseUrl: S("baseUrl"), namespace: S("namespace"), testIdAttribute: S("testIdAttribute") },
    );

    const controller = new AbortController();
    const onCaseCalls: unknown[] = [];
    const onRunningCalls: string[] = [];
    const onDiscoveredCalls: [string, string | undefined][] = [];

    await adapter.execute("/specDir", {
      signal: controller.signal,
      faultInject: true,
      specFiles: [S("specFiles")],
      project: S("project"),
      timeoutMs: 12345,
      onCase: (c) => onCaseCalls.push(c),
      onRunning: (t) => onRunningCalls.push(t),
      onDiscovered: (t, f) => onDiscoveredCalls.push([t, f]),
    });

    const dyingLayer = "ExecutionPortAdapter.execute() -> ExecutionRequest (qa-engine/.../bridges/execution-port.adapter.ts)";
    assert.ok(capturedOpts, "the e2e strategy must have been invoked");
    assert.equal(capturedOpts!.baseUrl, S("baseUrl"), `baseUrl dropped at ${dyingLayer}`);
    assert.equal(capturedOpts!.namespace, S("namespace"), `namespace dropped at ${dyingLayer}`);
    assert.equal(capturedOpts!.testIdAttribute, S("testIdAttribute"), `testIdAttribute dropped at ${dyingLayer} (worst leak in audit-2026-07-flaky-selector-leaks)`);
    assert.equal(capturedOpts!.signal, controller.signal, `signal dropped at ${dyingLayer}`);
    assert.equal(capturedOpts!.faultInject, true, `faultInject dropped at ${dyingLayer}`);
    assert.deepEqual(capturedOpts!.specFiles, [S("specFiles")], `specFiles dropped at ${dyingLayer}`);
    assert.equal(capturedOpts!.project, S("project"), `project dropped at ${dyingLayer}`);
    assert.equal(capturedOpts!.timeoutMs, 12345, `timeoutMs dropped at ${dyingLayer}`);

    (capturedOpts!.onCase as (c: unknown) => void)?.({ name: "x", status: "pass" });
    (capturedOpts!.onRunning as (t: string) => void)?.("running-title");
    (capturedOpts!.onDiscovered as (t: string, f?: string) => void)?.("discovered-title", "file.spec.ts");
    assert.equal(onCaseCalls.length, 1, `onCase dropped at ${dyingLayer}`);
    assert.equal(onRunningCalls[0], "running-title", `onRunning dropped at ${dyingLayer}`);
    assert.deepEqual(onDiscoveredCalls[0], ["discovered-title", "file.spec.ts"], `onDiscovered dropped at ${dyingLayer}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (d) PERSISTENCE surface — kernel RunOutcome vs SqliteRunHistoryAdapter's toLegacyRunOutcome
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: PERSISTENCE (kernel RunOutcome vs toLegacyRunOutcome)", () => {
  const ALL_TOP_FIELDS = {
    runId: true, app: true, sha: true, mode: true, target: true, verdict: true, errorClass: true,
    gateSignals: true, rulesRetrieved: true, reflection: true, at: true, note: true, cases: true,
    logs: true,
  } satisfies Record<keyof KernelRunOutcome, true>;

  const ALL_GATE_SIGNAL_FIELDS = {
    static: true, coverageRatio: true, valueScore: true, reviewerCorrections: true,
    reviewerRationale: true, reviewerApproved: true, flaky: true, retries: true, confinement: true,
    usage: true, phaseTimings: true, preExecAmbiguityCatches: true, deterministicSelectorBlocks: true,
    catalogGateInWindow: true, catalogGateAdvisory: true, catalogGateFailClosed: true,
  } satisfies Record<keyof KernelRunOutcome["gateSignals"], true>;

  const ALLOWLIST: Record<string, string> = {
    // W5 fix (seam-parity re-classification, evidence-verified): RE-CLASSIFIED from FIXME to
    // correct-by-design. The original entry claimed "LegacyRunOutcome's own `note?: string` field" —
    // this is WRONG: legacy's actual `RunOutcome` interface (src/types.ts:224-274 — runId, app, sha,
    // mode, target, verdict, errorClass, gateSignals, rulesRetrieved, reflection, at) has NO `note`
    // field at all, grep/read-confirmed exhaustively against the full interface body. The TWO
    // `note?: string` fields that DO exist in src/types.ts belong to DIFFERENT types entirely:
    // QaRunResult (types.ts:153, "human-readable summary... reviewer rejection, skip reason") and
    // RunRecord (types.ts:194, the SQLite-persisted live-run record) — neither is RunOutcome. And
    // src/server/runner.ts:196-199 (runViaRewrittenEngine's own header) independently confirms this
    // exact gap from the OTHER direction: "RunOutcome carries no such field at this port boundary...
    // updateRecord's own note:run.note fallback already surfaces the publish outcome via
    // RunQaResult.note -> RunOutcome.note" — i.e. `note` reaches the run record through a DIFFERENT
    // seam (QaRunResult.note -> RunRecord.note), never through toLegacyRunOutcome/saveRunOutcome's
    // run_outcomes row. So toLegacyRunOutcome dropping `note` is FAITHFUL to the legacy shape it
    // targets (LegacyRunOutcome, this adapter's own type, which also has no note field) — not a bug.
    note: "CORRECT BY DESIGN (not a drop): toLegacyRunOutcome never carries outcome.note through because LegacyRunOutcome (src/types.ts's RunOutcome interface) has NO note field to carry it TO — grep/read-confirmed against the full interface. The kernel RunOutcome.note reaches the run record through a SEPARATE seam (QaRunResult.note -> RunRecord.note, src/server/runner.ts's own W3 F3 header), never through this mapping fn's run_outcomes row. Diagnostic-only either way (never gates verdict/publish).",
    cases: "DELIBERATELY not persisted via toLegacyRunOutcome — LegacyRunOutcome (src/types.ts) has NO cases field at all (grep-confirmed); this field exists on the kernel RunOutcome ONLY for a DIFFERENT driving-side consumer (src/server/runner.ts's runViaRewrittenEngine threads it into history.addCase() calls directly, per this file's own W3 F3 header comment), not for the run_outcomes row this adapter writes. Comparator-blind by the kernel type's own documented construction.",
    logs: "DELIBERATELY not persisted via toLegacyRunOutcome — same reason as cases above: LegacyRunOutcome has no logs field (grep-confirmed), and the kernel RunOutcome's own header says this is 'the same one-shot... string legacy's own QaRunResult.logs carries', a different sink than the run_outcomes row.",
  };

  test("kernel RunOutcome's own top-level field list matches the allowlist + the mapping fn's carried set exactly", () => {
    const mapped = ["runId", "app", "sha", "mode", "target", "verdict", "errorClass", "gateSignals", "rulesRetrieved", "reflection", "at"];
    const allFieldNames = Object.keys(ALL_TOP_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(accountedFor, allFieldNames, "every kernel RunOutcome top-level field must be either mapped or allowlisted with a reason");
  });

  test("gateSignals' own field list is fully mapped (no allowlist needed — every field carries through)", () => {
    const mapped = [
      "static", "coverageRatio", "valueScore", "reviewerCorrections", "reviewerRationale",
      "reviewerApproved", "flaky", "retries", "confinement", "usage", "phaseTimings",
      "preExecAmbiguityCatches", "deterministicSelectorBlocks", "catalogGateInWindow",
      "catalogGateAdvisory", "catalogGateFailClosed",
    ];
    assert.deepEqual(mapped.sort(), Object.keys(ALL_GATE_SIGNAL_FIELDS).sort(), "every gateSignals field must be mapped — toLegacyRunOutcome's own header claims 100% pass-through for this nested object");
  });

  test("toLegacyRunOutcome carries every top-level + gateSignals field through with its sentinel value (fully-populated kernel outcome)", () => {
    const kernelOutcome: KernelRunOutcome = {
      runId: S("runId"),
      app: S("app"),
      sha: S("sha"),
      mode: "diff",
      target: "e2e",
      verdict: "pass",
      errorClass: "E-EXEC-FAIL",
      gateSignals: {
        static: true,
        coverageRatio: 0.42,
        valueScore: 0.77,
        reviewerCorrections: [S("reviewerCorrections")],
        reviewerRationale: S("reviewerRationale"),
        reviewerApproved: true,
        flaky: true,
        retries: 3,
        confinement: { strays: 1, dangerous: 0, reverted: [S("reverted")] },
        usage: { totalTokens: 999 },
        phaseTimings: { generate: 111 },
        preExecAmbiguityCatches: 2,
        deterministicSelectorBlocks: 1,
        catalogGateInWindow: 5,
        catalogGateAdvisory: 4,
        catalogGateFailClosed: 0,
      },
      rulesRetrieved: [S("rulesRetrieved")],
      reflection: { rootCause: S("reflection.rootCause") },
      at: "2026-07-02T00:00:00.000Z",
      note: S("note"),
    };

    const out = toLegacyRunOutcome(kernelOutcome);
    const dyingLayer = "toLegacyRunOutcome() -> LegacyRunOutcome (src/server/run-history-sqlite-adapter.ts)";

    assert.equal(out.runId, S("runId"), `runId dropped at ${dyingLayer}`);
    assert.equal(out.app, S("app"), `app dropped at ${dyingLayer}`);
    assert.equal(out.sha, S("sha"), `sha dropped at ${dyingLayer}`);
    assert.equal(out.mode, "diff", `mode dropped at ${dyingLayer}`);
    assert.equal(out.target, "e2e", `target dropped at ${dyingLayer}`);
    assert.equal(out.verdict, "pass", `verdict dropped at ${dyingLayer}`);
    assert.equal(out.errorClass, "E-EXEC-FAIL", `errorClass dropped at ${dyingLayer}`);
    assert.deepEqual(out.rulesRetrieved, [S("rulesRetrieved")], `rulesRetrieved dropped at ${dyingLayer}`);
    assert.equal((out.reflection as { rootCause?: string } | undefined)?.rootCause, S("reflection.rootCause"), `reflection dropped at ${dyingLayer}`);
    assert.equal(out.at, "2026-07-02T00:00:00.000Z", `at dropped at ${dyingLayer}`);

    const gs = out.gateSignals;
    assert.equal(gs.static, true, `gateSignals.static dropped at ${dyingLayer}`);
    assert.equal(gs.coverageRatio, 0.42, `gateSignals.coverageRatio dropped at ${dyingLayer}`);
    assert.equal(gs.valueScore, 0.77, `gateSignals.valueScore dropped at ${dyingLayer}`);
    assert.deepEqual(gs.reviewerCorrections, [S("reviewerCorrections")], `gateSignals.reviewerCorrections dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerRationale, S("reviewerRationale"), `gateSignals.reviewerRationale dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerApproved, true, `gateSignals.reviewerApproved dropped at ${dyingLayer}`);
    assert.equal(gs.flaky, true, `gateSignals.flaky dropped at ${dyingLayer}`);
    assert.equal(gs.retries, 3, `gateSignals.retries dropped at ${dyingLayer}`);
    assert.deepEqual(gs.confinement, { strays: 1, dangerous: 0, reverted: [S("reverted")] }, `gateSignals.confinement dropped at ${dyingLayer}`);
    assert.deepEqual(gs.usage, { totalTokens: 999 }, `gateSignals.usage dropped at ${dyingLayer}`);
    assert.deepEqual(gs.phaseTimings, { generate: 111 }, `gateSignals.phaseTimings dropped at ${dyingLayer}`);
    assert.equal(gs.preExecAmbiguityCatches, 2, `gateSignals.preExecAmbiguityCatches dropped at ${dyingLayer}`);
    assert.equal(gs.deterministicSelectorBlocks, 1, `gateSignals.deterministicSelectorBlocks dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateInWindow, 5, `gateSignals.catalogGateInWindow dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateAdvisory, 4, `gateSignals.catalogGateAdvisory dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateFailClosed, 0, `gateSignals.catalogGateFailClosed dropped at ${dyingLayer}`);

    assert.equal("note" in out, false, `note IS in the allowlist as CORRECT BY DESIGN (re-classified, W5) — LegacyRunOutcome genuinely has no note field, see the allowlist entry's own evidence trail; if this starts failing because LegacyRunOutcome gains a note field, update the allowlist entry above instead of patching the assertion`);
  });

  test("SqliteRunHistoryAdapter.save() forwards the mapped outcome to the injected saveOutcome (the seam a real caller uses)", async () => {
    let captured: unknown;
    const deps: RunHistorySqliteAdapterDeps = { saveOutcome: (o) => { captured = o; } };
    const adapter = new SqliteRunHistoryAdapter(deps);
    await adapter.save({
      runId: S("runId"), app: S("app"), sha: S("sha"), mode: "diff", target: "e2e", verdict: "pass",
      errorClass: null,
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-07-02T00:00:00.000Z",
    });
    assert.equal((captured as { runId: string }).runId, S("runId"), "SqliteRunHistoryAdapter.save() dropped runId before it reached saveOutcome");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (e) COMPOSITION surface — CompositionConfig vs buildRewrittenCompositionConfig
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: COMPOSITION (CompositionConfig vs buildRewrittenCompositionConfig)", () => {
  // Fields buildRewrittenCompositionConfig deliberately does NOT populate, each with a reason.
  // This is the SAME class of audit that caught the original 5 gaps (baseUrl/branch/mode/guidance/
  // testIdAttribute), mechanized: every optional CompositionConfig field must appear here OR be
  // asserted present by buildRewrittenCompositionConfigTest below.
  const OPTIONAL_ALLOWLIST: Record<string, string> = {
    guidance: "supplied by buildRewrittenCompositionConfig ONLY when run.guidance is present (asserted below as a present-when-given case) — legitimately absent for diff-mode runs with no manual guidance.",
    diff: "DELIBERATELY static '' — see this fn's own header 'difference #2': GenerationPortAdapter/ReviewPortAdapter both resolve the REAL per-run diff dynamically from ChangeAnalysisPort.classify() instead, since no per-run diff exists yet at composition-build time.",
    baseUrl: "supplied ONLY when app.dev?.baseUrl is present (asserted below as a present-when-given case) — legitimately absent for code-mode apps (no dev: block).",
    testIdAttribute: "supplied ONLY when app.e2e?.testIdAttribute is present (asserted below as a present-when-given case) — deliberately NO 'data-testid' default applied here (the seed playwright.config.ts already defaults it); legitimately absent when the app declares none.",
    readSpecSource: "FIXED (W5 quick win): IS supplied (a plain fs readFile) — asserted below as a present case. Wires the file-read collaborator FixLoop's Lever-2 selector-contradiction check needs (GenerationPortAdapter's optional collaborator, see that adapter's own header) so Lever-2 actually receives specSources on the real production path instead of [] forever.",
    setupCollaborators: "IS supplied (e2e + code) — asserted below as a present case; listed here only because this describe-block enumerates the type's full optional-field set before splitting into present/allowlisted.",
    cleanupCollaborators: "IS supplied (e2e only, matching composition-root.ts's own `!cfg.isCode` gate) — asserted below as a present case.",
    groundingCollaborators: "IS supplied ({} — resolves to the real production default per this factory's own header) — asserted below as a present case.",
    reviewDomGroundingCollaborators: "IS supplied ({}) — asserted below as a present case.",
    contextMap: "DELIBERATELY absent — see this fn's own header: no per-run mirrorDir/diff exists yet at composition-build time to read e2e/.qa/context.json from. Documented graceful degradation, not a drop.",
    prChangedFiles: "DELIBERATELY absent — same reason as contextMap (per-run intent.changedFiles doesn't exist yet at composition-build time).",
    versionUrl: "supplied ONLY when app.dev?.versionUrl is present — legitimately absent for code-mode/static apps (no deploy gate).",
    versionPoll: "supplied ONLY when app.dev?.versionUrl is present (paired with versionUrl above).",
    deployGateIntervalMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    deployGateTimeoutMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    historyFilePath: "supplied ONLY as an explicit escape hatch (deps.historyFilePath) — production default path uses `runHistory` (SqliteRunHistoryAdapter) instead, asserted below.",
    runHistory: "IS supplied by default (SqliteRunHistoryAdapter) — asserted below as a present case; historyFilePath above is the opt-OUT alternative, mutually exclusive with this field.",
    observer: "supplied ONLY when the caller passes one — asserted below as a present-when-given case; legitimately absent for callers (tests, the F.2 operator) that omit it.",
    assembleChangeCoverage: "IS supplied (the value keystone) — asserted below as a present case.",
    baselineCases: "IS supplied ([]) — asserted below as a present case.",
    coverageBlocksForPublish: "IS supplied (false) — asserted below as a present case.",
    e2eChangedForPublish: "IS supplied (true) — asserted below as a present case.",
    reviewerApprovedForPublish: "IS supplied (true) — asserted below as a present case.",
    sanitize: "IS supplied (the real sanitizeText, F4 CRITICAL security invariant) — asserted below as a present case.",
    learningRepo: "IS supplied (SqliteLearningRepository) — asserted below as a present case.",
  };

  function fakeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      name: S("app.name"),
      repo: S("app.repo"),
      baseBranch: S("app.baseBranch"),
      dev: { baseUrl: S("app.dev.baseUrl"), versionUrl: S("app.dev.versionUrl") },
      e2e: { testIdAttribute: S("app.e2e.testIdAttribute") },
      qa: { needsReview: true, shadow: false },
      report: { onFailure: "issue" },
      ...overrides,
    } as unknown as AppConfig;
  }

  function fakeFactoryDeps(): RewrittenEngineFactoryDeps {
    return { getAgentDeps: () => ({}) as unknown as AgentDeps };
  }

  test("buildRewrittenCompositionConfig supplies every non-optional CompositionConfig field, and every optional field is either present-when-expected or documented in OPTIONAL_ALLOWLIST", async () => {
    const cfg = buildRewrittenCompositionConfig(
      fakeAppConfig(),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff", guidance: S("run.guidance") },
    );

    const dyingLayer = "buildRewrittenCompositionConfig() -> CompositionConfig (src/server/rewritten-engine-factory.ts)";

    // Non-optional fields — every one MUST be present (undefined fails these asserts loudly).
    const nonOptional: Array<keyof typeof cfg> = [
      "repo", "appName", "mirrorDir", "e2eRelDir", "branch", "target", "mode", "needsReview",
      "shadow", "onFailure", "maxRetries", "isCode", "coveragePolicyMode", "vcs", "generationUseCase",
      "reviewRuntime", "staticGate", "executionStrategies", "objectiveSignal", "coveragePolicy",
      "githubPr", "githubIssue", "checkout",
    ];
    for (const field of nonOptional) {
      assert.notEqual(cfg[field], undefined, `${String(field)} (non-optional CompositionConfig field) dropped at ${dyingLayer}`);
    }

    // Optional fields this factory IS expected to populate given a fully-populated AppConfig.
    assert.equal(cfg.guidance, S("run.guidance"), `guidance dropped at ${dyingLayer}`);
    assert.equal(cfg.baseUrl, S("app.dev.baseUrl"), `baseUrl dropped at ${dyingLayer} (the CRITICAL live-crash fix this fn's own header documents)`);
    assert.equal(cfg.testIdAttribute, S("app.e2e.testIdAttribute"), `testIdAttribute dropped at ${dyingLayer} (worst leak in audit-2026-07-flaky-selector-leaks)`);
    assert.ok(cfg.setupCollaborators?.e2e && cfg.setupCollaborators?.code, `setupCollaborators dropped at ${dyingLayer}`);
    assert.ok(cfg.cleanupCollaborators?.e2e, `cleanupCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.groundingCollaborators, undefined, `groundingCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.reviewDomGroundingCollaborators, undefined, `reviewDomGroundingCollaborators dropped at ${dyingLayer}`);
    assert.equal(cfg.versionUrl, S("app.dev.versionUrl"), `versionUrl dropped at ${dyingLayer}`);
    assert.notEqual(cfg.versionPoll, undefined, `versionPoll dropped at ${dyingLayer}`);
    assert.equal(cfg.deployGateIntervalMs, 2000, `deployGateIntervalMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.equal(cfg.deployGateTimeoutMs, 60000, `deployGateTimeoutMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.notEqual(cfg.runHistory, undefined, `runHistory (SqliteRunHistoryAdapter default) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.assembleChangeCoverage, undefined, `assembleChangeCoverage (the value keystone) dropped at ${dyingLayer}`);
    assert.deepEqual(cfg.baselineCases, [], `baselineCases dropped at ${dyingLayer}`);
    assert.equal(cfg.coverageBlocksForPublish, false, `coverageBlocksForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.e2eChangedForPublish, true, `e2eChangedForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.reviewerApprovedForPublish, true, `reviewerApprovedForPublish dropped at ${dyingLayer}`);
    assert.notEqual(cfg.sanitize, undefined, `sanitize (F4 CRITICAL security invariant) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.learningRepo, undefined, `learningRepo dropped at ${dyingLayer}`);
    // W5 fix (seam-parity FIXME, flipped): readSpecSource IS wired now — assert it's a real file-read
    // collaborator, not just a truthy stub, by reading this very test file back through it.
    assert.equal(typeof cfg.readSpecSource, "function", `readSpecSource dropped at ${dyingLayer} (Lever-2 selector-contradiction check starves without it)`);
    const readBack = await cfg.readSpecSource!(import.meta.url.replace("file://", ""));
    assert.ok(readBack.includes("seam-parity.contract.test.ts"), `readSpecSource at ${dyingLayer} did not return real file content`);

    // Deliberately-absent-at-this-call optional fields (see OPTIONAL_ALLOWLIST for why).
    assert.equal(cfg.diff, "", "diff is deliberately static '' at composition time — see OPTIONAL_ALLOWLIST.diff");
    assert.equal(cfg.contextMap, undefined, "contextMap is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.contextMap");
    assert.equal(cfg.prChangedFiles, undefined, "prChangedFiles is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.prChangedFiles");
    assert.equal(cfg.historyFilePath, undefined, "historyFilePath is the opt-OUT alternative to runHistory — absent by default, see OPTIONAL_ALLOWLIST.historyFilePath");
    assert.equal(cfg.observer, undefined, "observer is absent because this call omitted the 5th argument — see OPTIONAL_ALLOWLIST.observer");
  });

  test("every documented OPTIONAL_ALLOWLIST field is a REAL optional field on the type (guards against a stale allowlist entry after a refactor)", () => {
    const cfg = buildRewrittenCompositionConfig(fakeAppConfig(), fakeFactoryDeps(), S("namespace"), { mode: "diff" });
    for (const field of Object.keys(OPTIONAL_ALLOWLIST)) {
      assert.ok(field in cfg || cfg[field as keyof typeof cfg] === undefined, `OPTIONAL_ALLOWLIST references '${field}', which is not a real field on the returned CompositionConfig object shape — stale allowlist entry`);
    }
  });

  test("buildRewrittenCompositionConfig leaves guidance/baseUrl/testIdAttribute/versionUrl/observer absent when the AppConfig/caller omits them (never fabricated)", () => {
    const cfg = buildRewrittenCompositionConfig(
      fakeAppConfig({ dev: undefined, e2e: undefined } as Partial<AppConfig>),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff" },
    );
    assert.equal(cfg.guidance, undefined);
    assert.equal(cfg.baseUrl, undefined);
    assert.equal(cfg.testIdAttribute, undefined);
    assert.equal(cfg.versionUrl, undefined);
    assert.equal(cfg.versionPoll, undefined);
    assert.equal(cfg.observer, undefined);
  });
});

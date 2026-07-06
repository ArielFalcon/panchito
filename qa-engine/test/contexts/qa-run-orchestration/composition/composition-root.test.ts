// test/contexts/qa-run-orchestration/composition/composition-root.test.ts
// Plan 7.6 (cutover finale): the legacy engine is DELETED — buildProduction(env, cfg) UNCONDITIONALLY
// wires a RewrittenOrchestratorAdapter now, regardless of PIPELINE_ENGINE. buildShadow(cfg) always
// wires the rewritten engine with the SHADOW publication path (no PR/Issue side effect) and a
// read-only history snapshot (no persistence to a real store) — unchanged by the cutover.
//
// Per the plan's own scope note for this task ("unit test uses lightweight FAKES for the heavy
// adapters — the real end-to-end wiring is exercised in Slice F, not here"), this test supplies
// fake collaborators (repo/mirror/coverage/etc.) rather than booting real git/Playwright/Stryker —
// the composition root's OWN job under test is "does it wire the 11 ports to the RIGHT bridge
// classes", not "does a real QA run pass end-to-end".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProduction,
  buildShadow,
  type CompositionConfig,
} from "@contexts/qa-run-orchestration/composition/composition-root.ts";
import { RewrittenOrchestratorAdapter } from "@contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts";
import { PIPELINE_ENGINE } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// ── A minimal fake CompositionConfig — every collaborator is a lightweight stub, matching the
// SAME stub shapes rewritten-orchestrator.adapter.test.ts already uses for the 10-scenario parity
// (this test does not re-run that parity; it proves the composition root wires the RIGHT classes).
function fakeConfig(overrides: Partial<CompositionConfig> = {}): CompositionConfig {
  const base: CompositionConfig = {
    repo: "org/app",
    appName: "app",
    mirrorDir: "/mirrors/org/app",
    e2eRelDir: "e2e",
    branch: "qa-bot/abc1234",
    target: "e2e",
    mode: "diff",
    needsReview: false,
    shadow: false,
    onFailure: "github-issue",
    maxRetries: 2,
    isCode: false,
    coveragePolicyMode: "signal",

    vcs: {
      blastRadius: async (sha) => BlastRadius.of(sha, ["src/x.ts"]),
      message: async () => "feat: add x",
      diff: async () => "diff --git a/src/x.ts b/src/x.ts",
    },
    generationUseCase: {
      generate: async () => ({ specs: ["a.spec.ts"], approved: true, reviewed: false }),
    },
    reviewRuntime: {
      runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) },
      rendering: { renderReviewer: () => ({ text: "", sectionSizes: {} }) },
      verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
    },
    staticGate: {
      validateAll: async () => ({ ok: true, errors: [], infra: false }),
    },
    executionStrategies: {
      e2e: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
      code: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    },
    objectiveSignal: {
      collector: { collect: async () => ({ covered: [] }) },
      oracle: { measure: async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" }) },
    },
    coveragePolicy: { mode: "signal", minRatio: 0.7 },
    learningRepo: {
      save: async () => {},
      topRules: async () => [],
      applyOutcome: async () => {},
    },
    checkout: async () => "/mirrors/org/app",
    versionUrl: undefined,
    versionPoll: async () => ({ serving: true }),
    githubPr: { openWithAutoMerge: async () => ({ url: "https://github.com/org/app/pull/1", number: 1 }) },
    githubIssue: { open: async () => ({ url: "https://github.com/org/app/issues/1", number: 1 }) },
    historyFilePath: "/tmp/qa-run-history.jsonl",
  };
  return { ...base, ...overrides };
}

// ── buildProduction: always wires the rewritten engine ─────────────────────────────────────────

test("buildProduction returns a RewrittenOrchestratorAdapter when PIPELINE_ENGINE is absent", () => {
  const port = buildProduction({}, fakeConfig());
  assert.ok(port instanceof RewrittenOrchestratorAdapter);
});

test("buildProduction returns a RewrittenOrchestratorAdapter even when PIPELINE_ENGINE='legacy' (accepted-but-ignored)", () => {
  const port = buildProduction({ [PIPELINE_ENGINE]: "legacy" }, fakeConfig());
  assert.ok(port instanceof RewrittenOrchestratorAdapter);
});

test("buildProduction returns a RewrittenOrchestratorAdapter when PIPELINE_ENGINE='rewritten'", () => {
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, fakeConfig());
  assert.ok(port instanceof RewrittenOrchestratorAdapter);
});

test("buildProduction(rewritten) drives a full run end-to-end through the 11 wired ports (green-pr shape)", async () => {
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, fakeConfig());

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

// ── reflector-rewire (design ADR-5, task 4.3 smoke test): confirms the composition root actually
// threads cfg.reflectorPort through to RunQaUseCaseDeps.reflector — not just that the config TYPE
// accepts the field. wireBridges() is not exported, so this drives a real run through the public
// buildProduction() entry point and observes the fake reflector's own call count, exactly the same
// black-box style the "shadow-log publication" test above uses for githubPr/githubIssue. ───────

test("buildProduction wires cfg.reflectorPort through to RunQaUseCase — a static-gate invalid run reaches reflector.reflect()", async () => {
  let reflectCallCount = 0;
  const cfg = fakeConfig({
    staticGate: { validateAll: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"], infra: false }) },
    reflectorPort: {
      reflect: async () => { reflectCallCount++; },
    },
  });

  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-reflector-smoke",
  });

  assert.equal(outcome.verdict, "invalid");
  assert.equal(reflectCallCount, 1, "cfg.reflectorPort must be wired through to RunQaUseCaseDeps.reflector — a static-gate invalid is gate-true (errorClass E-STATIC is not in the suppressed {E-INFRA, E-FLAKY} set)");
});

test("buildProduction omits reflector entirely when cfg.reflectorPort is absent — no behavior change on a green pass", async () => {
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, fakeConfig());

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-reflector-absent-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

// ── buildShadow: always rewritten, shadow-log publication, no side effects ────────────────────

test("buildShadow always returns a RewrittenOrchestratorAdapter regardless of PIPELINE_ENGINE", () => {
  const port = buildShadow(fakeConfig());
  assert.ok(port instanceof RewrittenOrchestratorAdapter);
});

test("buildShadow wires the shadow-log publication path — no PR/Issue collaborator is ever invoked", async () => {
  let prCalled = false;
  let issueCalled = false;
  const cfg = fakeConfig({
    githubPr: {
      openWithAutoMerge: async () => {
        prCalled = true;
        return { url: "https://github.com/org/app/pull/1", number: 1 };
      },
    },
    githubIssue: {
      open: async () => {
        issueCalled = true;
        return { url: "https://github.com/org/app/issues/1", number: 1 };
      },
    },
  });

  const port = buildShadow(cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-shadow-smoke",
  });

  assert.equal(outcome.verdict, "pass");
  assert.equal(prCalled, false);
  assert.equal(issueCalled, false);
});

test("buildShadow reads a pre-run history snapshot (read-only) — never persists via a durable store", async () => {
  // A history-write spy plugged in as the historyFilePath-backed collaborator would only be reachable
  // if buildShadow used FileRunHistoryAdapter — it must use InMemoryRunHistoryAdapter instead so no
  // real file is ever touched. Passing a deliberately-unwritable path proves this: if buildShadow
  // wired FileRunHistoryAdapter, the run() would throw on the disallowed write; it must not.
  const cfg = fakeConfig({ historyFilePath: "/nonexistent/dir/that/does/not/exist/history.jsonl" });
  const port = buildShadow(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-shadow-history",
  });

  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) selects NullDeployGateAdapter when versionUrl is absent (static/code target)", async () => {
  const cfg = fakeConfig({ versionUrl: undefined });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  // No versionUrl -> NullDeployGateAdapter (always ok(true)) -> the entry gate never blocks.
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-null-gate",
  });

  assert.notEqual(outcome.verdict, "infra-error");
});

test("buildProduction(rewritten) selects the real DeployGatePortAdapter when versionUrl is present", async () => {
  const cfg = fakeConfig({
    versionUrl: "https://dev.example.com/version",
    versionPoll: async () => ({ serving: true }),
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-real-gate",
  });

  assert.equal(outcome.verdict, "pass");
});

// A3: testIdAttribute must flow from CompositionConfig into the ExecutionPortAdapter's static
// context so PW_TEST_ID_ATTRIBUTE reaches the verdictual Playwright run. NO defaulting logic here —
// undefined flows through; the seed playwright.config.ts already defaults to data-testid.
test("buildProduction(rewritten) threads testIdAttribute into the ExecutionPortAdapter", async () => {
  let capturedTestIdAttribute: string | undefined;
  const cfg = fakeConfig({
    testIdAttribute: "data-cy",
    executionStrategies: {
      e2e: {
        run: async (req) => {
          capturedTestIdAttribute = req.testIdAttribute;
          return { verdict: "pass", cases: [], logs: "" };
        },
      },
      code: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-test-id-attribute",
  });

  assert.equal(capturedTestIdAttribute, "data-cy");
});

// SetupPort (CLAUDE.md run-flow step 3) — genuine-wiring proof: setupCollaborators (OPTIONAL on
// CompositionConfig) must reach the run() call when supplied, and stay a silent no-op when absent
// (every fakeConfig() base case above never supplies it — that already proves the absent-collaborator
// backward-compat path across all the OTHER tests in this file).

test("buildProduction(rewritten) wires setupCollaborators.e2e into the run when target is 'e2e'", async () => {
  let setupCalled = false;
  const cfg = fakeConfig({
    target: "e2e",
    setupCollaborators: {
      e2e: async () => { setupCalled = true; },
      code: async () => { throw new Error("must not be called for target 'e2e'"); },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-e2e",
  });

  assert.equal(setupCalled, true, "the e2e setup collaborator must run before generation when setupCollaborators is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) wires setupCollaborators.code into the run when target is 'code'", async () => {
  let setupCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    setupCollaborators: {
      e2e: async () => { throw new Error("must not be called for target 'code'"); },
      code: async () => { setupCalled = true; },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-setup-code",
  });

  assert.equal(setupCalled, true, "the code setup collaborator must run before generation when setupCollaborators is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) surfaces infra-error when a wired setup collaborator throws", async () => {
  const cfg = fakeConfig({
    target: "e2e",
    setupCollaborators: {
      e2e: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
      code: async () => {},
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-throw",
  });

  assert.equal(outcome.verdict, "infra-error", "a setup failure must surface as infra-error, matching src/qa/setup.ts's own contract");
});

test("buildProduction(rewritten) runs without setupCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig(); // fakeConfig()'s base never supplies setupCollaborators
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-absent",
  });

  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) surfaces infra-error when the real deploy gate never serves", async () => {
  const cfg = fakeConfig({
    versionUrl: "https://dev.example.com/version",
    versionPoll: async () => ({ serving: false }),
    // Bounded low so this test proves the timeout PATH without waiting out a real poll window —
    // deployGateTimeoutMs/deployGateIntervalMs are CompositionConfig's own knobs (default 60s/2s in
    // production), not hardcoded inside DeployGatePortAdapter.
    deployGateTimeoutMs: 20,
    deployGateIntervalMs: 5,
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-gate-timeout",
  });

  assert.equal(outcome.verdict, "infra-error");
});

// ── W2 F4 (judgment-day, both rounds): the single-reviewer architecture's load-bearing wire ────
// composition-root MUST pass needsReview:false into GenerationPortAdapter's static ctx REGARDLESS
// of cfg.needsReview — RunQaUseCase's ReviewPort is the single reviewer; GenerateTestsUseCase's
// internal degraded reviewer must never fire on the orchestrated path. The prior judge round found
// this wiring correct but UNTESTED (a one-line revert to `needsReview: cfg.needsReview` would have
// passed the whole gate). This test is the executable proof: a recording generationUseCase fake
// observes the actual input the adapter builds from its ctx.
test("wireBridges hardcodes needsReview:false into the generation ctx even when cfg.needsReview is true (single-reviewer architecture)", async () => {
  const seenNeedsReview: boolean[] = [];
  const cfg = fakeConfig({
    needsReview: true, // the RunQaConfig knob — must NOT leak into the generation ctx
    generationUseCase: {
      generate: async (input: { needsReview?: boolean }) => {
        seenNeedsReview.push(input.needsReview === true);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildShadow(cfg);
  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-single-reviewer",
  });

  assert.ok(seenNeedsReview.length > 0, "the generation use-case must have been invoked");
  assert.ok(
    seenNeedsReview.every((v) => v === false),
    "GenerationPortAdapter's ctx must carry needsReview:false on every generate() call — the internal degraded reviewer must never fire on the orchestrated path",
  );
});

// ── Plan 7-R W4 (audit CRITICAL): PreGenerationGroundingPort / ReviewDomGroundingPort — genuine-
// wiring proof. groundingCollaborators/reviewDomGroundingCollaborators (OPTIONAL on
// CompositionConfig) must reach the run() call when supplied, and stay a silent no-op (isCode OR
// absent collaborators) otherwise — every fakeConfig() base case above never supplies them, which
// already proves the absent-collaborator backward-compat path across the OTHER tests in this file.

test("buildProduction(rewritten) wires groundingCollaborators.buildContextPack into the run when target is 'e2e' — contextPack reaches OpencodeRunInput", async () => {
  let buildCalled = false;
  const seenContextPacks: Array<string | undefined> = [];
  const cfg = fakeConfig({
    target: "e2e",
    isCode: false,
    baseUrl: "https://dev.example.com",
    groundingCollaborators: {
      buildContextPack: async () => {
        buildCalled = true;
        return { text: "## Context Pack\n\nwired", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
    generationUseCase: {
      generate: async (input) => {
        seenContextPacks.push(input.contextPack);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-grounding-contextpack",
  });

  assert.equal(buildCalled, true, "the injected buildContextPack collaborator must have run before the initial generate() call");
  assert.ok(seenContextPacks.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenContextPacks[0], "## Context Pack\n\nwired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) does NOT wire grounding on the code target, even when groundingCollaborators is supplied (isCode has no DOM/routes to ground)", async () => {
  let buildCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    groundingCollaborators: {
      buildContextPack: async () => { buildCalled = true; return { text: "should never run", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }; },
    },
    setupCollaborators: { e2e: async () => {}, code: async () => {} },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-grounding-code-skip",
  });

  assert.equal(buildCalled, false, "groundingCollaborators must never be invoked on the code target");
  assert.equal(outcome.verdict, "pass");
});

// ── CodeGraph Phase 4 (design §5.3/§6, tasks 4b.6): the OPTIONAL structuralSignal collaborator. ──
// Present -> wireBridges constructs a StructuralSignalPortAdapter over the REAL
// CodebaseMemoryCodeGraphAdapter, resolving `project` from repoDir via the injected resolver
// (design §6's list_projects lookup, ADR-4's "no live syncTo" decision unchanged). Absent -> the
// use-case's own structuralSignal dep stays undefined — NEVER a stub ok([])-shaped fake — matching
// groundingCollaborators' own [SWAP] precedent exactly.

test("buildProduction(rewritten) wires structuralSignal when a codebaseMemory collaborator is supplied — the rendered advisory block reaches OpencodeRunInput.staticSignal", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    codebaseMemory: {
      cli: async (tool: string, jsonArg: string) => {
        if (tool === "list_projects") return { code: 0, stdout: JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }), stderr: "" };
        const parsed = JSON.parse(jsonArg) as { query: string };
        if (parsed.query.includes("FILE_CHANGES_WITH")) return { code: 0, stdout: JSON.stringify({ columns: ["f_path", "g_path", "coupling_score", "co_changes"], rows: [], total: 0 }), stderr: "" };
        // impactedSymbols outbound/inbound + callersOf all share the same {columns,rows} shape —
        // the confidence column is per-hop-named (r1_conf/r2_conf/...), NOT a bare "confidence".
        return {
          code: 0,
          stdout: JSON.stringify({
            columns: ["a_file", "a_name", "b_name", "b_file", "r1_conf"],
            rows: [["src/x.ts", "handleX", "helperFn", "src/helper.ts", "0.9"]],
            total: 1,
          }),
          stderr: "",
        };
      },
    },
    vcs: {
      blastRadius: async (sha) => BlastRadius.of(sha, ["src/x.ts"]),
      message: async () => "feat: add x",
      diff: async () => "diff --git a/src/x.ts b/src/x.ts\n+ handleX();",
    },
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-present",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.match(seenStaticSignals[0] ?? "", /Structural blast radius/, "the composed advisory block must reach OpencodeRunInput.staticSignal when the collaborator is wired and the repo resolves to an indexed project");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) leaves structuralSignal undefined when codebaseMemory is absent (no section, backward compatible)", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  }); // fakeConfig()'s base never supplies codebaseMemory
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-absent",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenStaticSignals[0], undefined, "staticSignal must stay entirely absent when no codebaseMemory collaborator is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) degrades structuralSignal to no section when the repo does not resolve to any indexed project (unindexed-repo degrade)", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    codebaseMemory: {
      // No matching project for this repoDir — mirrors the real `list_projects` response for an
      // unindexed watched app (verified empirically: panchito itself returns no match today).
      cli: async (tool: string) => {
        if (tool === "list_projects") return { code: 0, stdout: JSON.stringify({ projects: [{ name: "some-other-app", root_path: "/mirrors/some/other" }] }), stderr: "" };
        return { code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" };
      },
    },
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-unindexed",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenStaticSignals[0], undefined, "an unindexed repo (no list_projects match) must degrade to no staticSignal, never a fabricated or empty-but-present section");
  assert.equal(outcome.verdict, "pass");
});

// ── Stitcher→Generation seam (design §3.6, S2.6): the OPTIONAL serviceTopology collaborator. ──
// Present -> wireBridges constructs a ServiceLinksPortAdapter over a REAL MirrorRegistryAdapter (DI,
// not a static call) and a real BoundaryProfileProviderPort. Absent -> serviceLinks stays undefined,
// NEVER a stub — matching structuralSignal/groundingCollaborators' own [SWAP] precedent exactly.

test("buildProduction(rewritten) wires serviceLinks when a serviceTopology collaborator is supplied — the REAL MirrorRegistryAdapter(mirrorRoot) encoding is exercised end-to-end (existsSync sees the SAME '__'-joined dir wireBridges constructs)", async () => {
  const root = mkdtempSync(join(tmpdir(), "composition-service-links-"));
  try {
    // MirrorRegistryAdapter's own formula: join(mirrorRoot, repo.replaceAll("/", "__")) — creating
    // dirs under exactly that encoding proves wireBridges constructed a REAL MirrorRegistryAdapter
    // (not a stub/bypass): if it were a static/wrong formula, the adapter's existsSync checks below
    // would find nothing and short-circuit to {links:[],drift:[]} BEFORE ever calling forApp().
    mkdirSync(join(root, "org__front"), { recursive: true });
    mkdirSync(join(root, "org__ms-orders"), { recursive: true });

    const httpProfile: BoundaryProfile = {
      transport: "http",
      frontFiles: "*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    };
    let forAppCallCount = 0;
    let forAppCalledWith: string | undefined;
    const seenServiceLinks: Array<unknown[] | undefined> = [];
    const cfg = fakeConfig({
      mode: "diff",
      repo: "org/front",
      serviceTopology: {
        appName: "app",
        primaryRepo: "org/front",
        mirrorRoot: root,
        services: [{ repo: "org/ms-orders" }],
        boundaryProfiles: {
          forApp: async (appName: string) => { forAppCallCount++; forAppCalledWith = appName; return [httpProfile]; },
        },
      },
      generationUseCase: {
        generate: async (input) => {
          seenServiceLinks.push(input.serviceLinks);
          return { specs: ["a.spec.ts"], approved: true, reviewed: false };
        },
      },
    });
    const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-service-links-present",
    });

    assert.ok(seenServiceLinks.length > 0, "generationUseCase.generate must have been invoked");
    assert.equal(forAppCallCount, 1, "boundaryProfiles.forApp() must have been called exactly once — this only happens PAST the existsSync gate, proving the REAL MirrorRegistryAdapter('__'-join) resolved to the SAME dirs this test created on disk");
    assert.equal(forAppCalledWith, "app", "forApp must be called with the serviceTopology.appName supplied via CompositionConfig");
    assert.equal(outcome.verdict, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildProduction(rewritten) leaves serviceLinks undefined when serviceTopology is absent (no key, backward compatible)", async () => {
  const seenEnrichments: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenEnrichments.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  }); // fakeConfig()'s base never supplies serviceTopology
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-service-links-absent",
  });

  assert.ok(seenEnrichments.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenEnrichments[0]?.serviceLinks, undefined, "serviceLinks must stay entirely absent when no serviceTopology collaborator is wired");
  assert.equal(outcome.verdict, "pass");
});

// ── Cross-repo generation-prompt parity (legacy pipeline.ts:1909, restored by d8e7106's own
// triggerService threading): CompositionConfig.triggerService is the ONE new optional field this
// gap closes — advisory, prompt-context only (reaches GenerationPortAdapter's ctx.service ->
// OpencodeRunInput.service and NOTHING else: no verdict/gate/coverage/publish path reads it).
// Present -> the generation input carries {repo, mirrorDir(, openapi)} for the TRIGGERING service.
// Absent (the common same-repo case) -> the key is omitted entirely, matching serviceLinks/
// crossRepoImpact's own [SWAP] precedent immediately above.

test("buildProduction(rewritten) threads cfg.triggerService into OpencodeRunInput.service when the run is cross-repo", async () => {
  const seenServices: Array<unknown> = [];
  const cfg = fakeConfig({
    mode: "diff",
    repo: "org/front",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi.yaml" },
    generationUseCase: {
      generate: async (input) => {
        seenServices.push(input.service);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-trigger-service-present",
  });

  assert.ok(seenServices.length > 0, "generationUseCase.generate must have been invoked");
  assert.deepEqual(seenServices[0], { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi.yaml" });
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) leaves OpencodeRunInput.service entirely absent when cfg.triggerService is not supplied (same-repo run)", async () => {
  const seenInputs: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenInputs.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  }); // fakeConfig()'s base never supplies triggerService
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-trigger-service-absent",
  });

  assert.ok(seenInputs.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal("service" in (seenInputs[0] ?? {}), false, "no cfg.triggerService (the common same-repo case) must OMIT the key, not set it to undefined");
  assert.equal(outcome.verdict, "pass");
});

// ── Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap, restored by
// this fix): CompositionConfig.services is the ONE new optional field this gap closes — advisory,
// prompt-context ONLY (reaches GenerationPortAdapter's ctx.services -> OpencodeRunInput.services and
// NOTHING else: no verdict/gate/coverage/publish path reads it). Present -> every declared service ref
// reaches the generation input. Absent/empty -> the key is omitted entirely, matching triggerService's
// own [SWAP] precedent immediately above.

test("buildProduction(rewritten) threads cfg.services into OpencodeRunInput.services for a context-mode run", async () => {
  const seenServicesList: Array<unknown> = [];
  const cfg = fakeConfig({
    mode: "context",
    repo: "org/front",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/mirrors/org__payments-svc" },
    ],
    generationUseCase: {
      generate: async (input) => {
        seenServicesList.push(input.services);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "context",
    target: "e2e",
    runId: "composition-root-services-present",
  });

  assert.ok(seenServicesList.length > 0, "generationUseCase.generate must have been invoked");
  assert.deepEqual(seenServicesList[0], [
    { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" },
    { repo: "org/payments-svc", mirrorDir: "/mirrors/org__payments-svc" },
  ]);
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) leaves OpencodeRunInput.services entirely absent when cfg.services is not supplied", async () => {
  const seenInputs: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenInputs.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false };
      },
    },
  }); // fakeConfig()'s base never supplies services
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-services-absent",
  });

  assert.ok(seenInputs.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal("services" in (seenInputs[0] ?? {}), false, "no cfg.services (the common case) must OMIT the key, not set it to undefined or an empty array");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) runs without groundingCollaborators/reviewDomGroundingCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig({ target: "e2e", isCode: false }); // fakeConfig()'s base never supplies either
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-grounding-absent",
  });

  assert.equal(outcome.verdict, "pass", "the run must complete normally with no grounding collaborators wired");
});

// ── Plan 7-R B5.3 (audit CRITICAL): PreExecGroundingPort — the W1/W2 pre-execution gate is a NO-OP
// on every production run today because wireBridges() never constructs the adapter. Mirrors the
// preGenerationGrounding/reviewDomGrounding [SWAP] precedent immediately above: OPTIONAL on
// CompositionConfig, absent -> the use-case's whole W1/W2 phase stays a no-op (preExecAmbiguityCatches
// stays the literal 0 it was before), and gated `!cfg.isCode` (isCode has no DOM/routes to ground).

test("buildProduction(rewritten) wires preExecGrounding into the run when target is 'e2e' and a captureRouteTrees-shaped collaborator is supplied", async () => {
  // A REAL specDir with at least one on-disk *.spec.ts — the adapter enumerates + reads specs off
  // disk itself (the "adapter resolves its own paths" precedent), so an unpopulated fakeConfig()
  // mirrorDir (never a real directory) would short-circuit BEFORE ever calling captureRouteTrees.
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-preexec-wired-"));
  try {
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", "home.spec.ts"), "test('home', async ({ page }) => { await page.goto('/home'); });");

    let captureCalled = false;
    const cfg = fakeConfig({
      target: "e2e",
      isCode: false,
      baseUrl: "https://dev.example.com",
      checkout: async () => mirrorDir,
      preExecGroundingCollaborators: {
        captureRouteTrees: async () => {
          captureCalled = true;
          return [{ route: "/home", nodes: ["heading: Home"] }];
        },
      },
    });
    const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-preexec-grounding-wired",
    });

    assert.equal(captureCalled, true, "the injected captureRouteTrees collaborator must have run (W1's pre-exec grounding check)");
    assert.equal(outcome.verdict, "pass");
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
});

test("buildProduction(rewritten) does NOT wire preExecGrounding on the code target, even when preExecGroundingCollaborators is supplied (isCode has no DOM/routes to ground)", async () => {
  let captureCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    preExecGroundingCollaborators: {
      captureRouteTrees: async () => { captureCalled = true; return []; },
    },
    setupCollaborators: { e2e: async () => {}, code: async () => {} },
  });
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-preexec-grounding-code-skip",
  });

  assert.equal(captureCalled, false, "preExecGroundingCollaborators must never be invoked on the code target");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction(rewritten) runs without preExecGroundingCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig({ target: "e2e", isCode: false }); // fakeConfig()'s base never supplies it
  const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-preexec-grounding-absent",
  });

  assert.equal(outcome.verdict, "pass", "the run must complete normally with no preExecGrounding collaborators wired");
});

// ── Plan 7-R B5.3, end-to-end proof: the gate must actually FIRE through the real composition path,
// not just receive a call. A stubbed capture returning a route with a DUPLICATE page-rooted node
// (two "button: Submit" lines) against a spec whose generation output emits
// `page.getByRole('button', { name: 'Submit' })` must drive W1's checkPreExecGrounding to a
// preExecAmbiguityCatches > 0 result — proving the counters are no longer structurally zero once
// wireBridges is fixed. Before the adapter exists, this run's gateSignals.preExecAmbiguityCatches
// stays the literal 0 the port's own [SWAP]-absent doc describes.
test("buildProduction(rewritten) end-to-end: a duplicate page-rooted selector in the captured route trips the W1 pre-exec ambiguity gate (preExecAmbiguityCatches > 0)", async () => {
  // A REAL specDir (mirrorDir/e2eRelDir) — the adapter under test resolves its own paths off disk
  // (the "adapter resolves its own paths" precedent SetupPort/ExecutionPort/ReviewDomGroundingPort
  // already use), so this is exercised against real fs, not a readSpecSource passthrough.
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-preexec-e2e-"));
  try {
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    // Page-rooted, undisambiguated getByRole — the ONE shape unscopedMultipleContradictions keeps
    // (selector-check.ts): rooted directly on `page`, no trailing .first()/.nth()/.filter().
    writeFileSync(
      join(mirrorDir, "e2e", "ambiguous.spec.ts"),
      "test('checkout', async ({ page }) => { await page.goto('/checkout'); await page.getByRole('button', { name: 'Submit' }).click(); });",
    );

    const cfg = fakeConfig({
      target: "e2e",
      isCode: false,
      baseUrl: "https://dev.example.com",
      checkout: async () => mirrorDir,
      generationUseCase: {
        generate: async () => ({
          specs: ["ambiguous.spec.ts"],
          approved: true,
          reviewed: false,
        }),
      },
      preExecGroundingCollaborators: {
        // Stubs the render seam only — captureRouteTrees' own route-extraction/filtering logic still
        // runs for real; this collaborator plays the role of CaptureDomDeps.render, returning a
        // route with a DUPLICATE page-rooted node ("button: Submit" twice) so selectorUnique's
        // count > 1 fires a MULTIPLE contradiction for the spec's page.getByRole('button', {name:
        // 'Submit'}) call.
        captureRouteTrees: async () => [
          { route: "/checkout", nodes: ["button: Submit", "button: Submit"] },
        ],
      },
    });
    const port = buildProduction({ [PIPELINE_ENGINE]: "rewritten" }, cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-preexec-grounding-fires",
    });

    const preExecAmbiguityCatches = outcome.gateSignals.preExecAmbiguityCatches ?? 0;
    assert.ok(
      preExecAmbiguityCatches > 0,
      `expected the W1 pre-exec ambiguity gate to fire (preExecAmbiguityCatches > 0), got ${preExecAmbiguityCatches}`,
    );
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
});

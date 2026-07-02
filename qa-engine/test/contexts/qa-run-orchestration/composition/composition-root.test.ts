// test/contexts/qa-run-orchestration/composition/composition-root.test.ts
// RED-first (Task E.2): buildProduction(env, cfg) selects LegacyPipelineAdapter (PIPELINE_ENGINE
// absent/"legacy") or RewrittenOrchestratorAdapter (PIPELINE_ENGINE="rewritten") per the E.1 flag
// (selectEngine) — the shadow seam, NOT the cutover (Plan 6 never ships rewritten as the default).
// buildShadow(cfg) always wires the rewritten engine with the SHADOW publication path (no PR/Issue
// side effect) and a read-only history snapshot (no persistence to a real store).
//
// Per the plan's own scope note for this task ("unit test uses lightweight FAKES for the heavy
// adapters — the real end-to-end wiring is exercised in Slice F, not here"), this test supplies
// fake collaborators (repo/mirror/coverage/etc.) rather than booting real git/Playwright/Stryker —
// the composition root's OWN job under test is "does it wire the 11 ports to the RIGHT bridge
// classes and dispatch by flag", not "does a real QA run pass end-to-end".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProduction,
  buildShadow,
  type CompositionConfig,
} from "@contexts/qa-run-orchestration/composition/composition-root.ts";
import { LegacyPipelineAdapter, type LegacyRunner } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
import { RewrittenOrchestratorAdapter } from "@contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts";
import { PIPELINE_ENGINE } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

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

// ── buildProduction: engine selection by PIPELINE_ENGINE ──────────────────────────────────────

function fakeLegacyRunner(): LegacyRunner {
  return {
    app: { name: "app" },
    deps: { savedOutcomes: [] as RunOutcome[] },
    runPipeline: async () => ({ verdict: "pass" }),
  };
}

test("buildProduction returns a LegacyPipelineAdapter when PIPELINE_ENGINE is absent (fail-safe default)", () => {
  const port = buildProduction({}, fakeConfig(), { legacyRunner: fakeLegacyRunner() });
  assert.ok(port instanceof LegacyPipelineAdapter);
});

test("buildProduction returns a LegacyPipelineAdapter when PIPELINE_ENGINE='legacy'", () => {
  const port = buildProduction({ [PIPELINE_ENGINE]: "legacy" }, fakeConfig(), { legacyRunner: fakeLegacyRunner() });
  assert.ok(port instanceof LegacyPipelineAdapter);
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

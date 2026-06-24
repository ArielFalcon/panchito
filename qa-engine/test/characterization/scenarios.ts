// Scenario stubs for golden capture. Each case mirrors an existing pipeline.test.ts test exactly:
// the same AppConfig, same QaRunResult, same PipelineDeps stub shape. Do NOT invent behavior here.
// Source tests (pipeline.test.ts line numbers current as of Plan-1):
//   green-pr      → "green opens a PR, NOT an Issue" (~L580)
//   fail-issue    → "on failure opens an Issue with the SHA and does NOT publish" (~L596)
//   flaky-quarantine → "flaky: neither PR nor Issue (quarantine)" (~L608)
//   no-op-skip    → "agent writes no specs (no-op change): skipped" (~L568)
//   invalid-issue → "invalid specs: does NOT execute or publish" (~L619)
//   infra-error   → "DEV unhealthy before execution: infra-error" (~L1006)
//   code-mode     → "code mode green: no gate/validate/health" (~L1112)
//   cross-repo    → "cross-repo: service trigger prepares BOTH mirrors" (~L1759)
//   shadow        → "shadow mode: on green does NOT publish, only logs" (~L1072)
//   context       → "context mode: generates context.json, validates it, publishes" (~L1187)

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineDeps } from "../../../src/pipeline.ts";
import type { AppConfig } from "../../../src/orchestrator/config-loader.ts";
import type { RunOutcome, QaRunResult, AgentResult, RunMode, TestTarget } from "../../../src/types.ts";

export type ScenarioKey =
  | "green-pr"
  | "fail-issue"
  | "flaky-quarantine"
  | "no-op-skip"
  | "invalid-issue"
  | "infra-error"
  | "code-mode"
  | "cross-repo"
  | "shadow"
  | "context";

// Captures every saved outcome — mirrors pipeline.test.ts's d.savedOutcomes.
export interface CaptureDeps extends PipelineDeps {
  savedOutcomes: RunOutcome[];
}

// ── Shared fixtures (exact copies of the pipeline.test.ts stubs) ───────────────

export const scenarioApp: AppConfig = {
  name: "demo",
  repo: "org/demo",
  dev: {
    baseUrl: "https://dev",
    versionUrl: "https://dev/version",
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
  },
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
};

const shadowApp: AppConfig = {
  ...scenarioApp,
  qa: { ...scenarioApp.qa, shadow: true },
};

const codeApp: AppConfig = {
  name: "panchito",
  repo: "org/panchito",
  code: true,
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
};

const crossApp: AppConfig = {
  name: "shop",
  repo: "org/shop-front",
  baseBranch: "main",
  dev: { baseUrl: "https://dev.shop.io" },
  services: [{ repo: "org/orders-svc", versionUrl: "https://svc/version" }],
  qa: { needsReview: false, testDataPrefix: "qa-shop", shadow: false },
  report: { onFailure: "github-issue" },
};

const generated: AgentResult = {
  output: "spec",
  specs: ["a.spec.ts"],
  reviewed: true,
  approved: true,
};

const noopAgent: AgentResult = {
  output: "the change needs no tests",
  specs: [],
  reviewed: true,
  approved: true,
};

function passing(): QaRunResult {
  return { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
}

// ── Minimal stub builder (mirrors the inline deps() helper in pipeline.test.ts) ─
// Only wires the stubs each scenario actually needs.

function makeDeps(opts: {
  run?: QaRunResult;
  healthy?: boolean;
  validation?: { ok: boolean; errors: string[]; infra: boolean };
  agent?: AgentResult;
  isCodeMode?: boolean;
  isCrossRepo?: boolean;
  isShadow?: boolean;
  isContext?: boolean;
  prUrl?: string | null;
}): CaptureDeps {
  const savedOutcomes: RunOutcome[] = [];

  // Build a mirror dir with the context.json the pipeline expects (mirrors the pipeline.test.ts deps()).
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-golden-"));
  mkdirSync(join(mirrorDir, "e2e", ".qa"), { recursive: true });
  writeFileSync(
    join(mirrorDir, "e2e", ".qa", "context.json"),
    JSON.stringify({ builtAtSha: "abc123", routes: [], api: [], feBe: [] }),
  );

  const run = opts.run ?? passing();

  const base: CaptureDeps = {
    savedOutcomes,

    waitForDeploy: async () => {},
    prepare: async (repo: string, sha: string) => ({
      mirrorDir,
      diff: "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+const x = 1;",
      message: "feat: change",
    }),
    prepareAtBranch: async (_repo: string, _branch: string) => ({ mirrorDir }),
    generate: async () => opts.agent ?? generated,
    setupE2e: async () => {},
    validate: async () => opts.validation ?? { ok: true, errors: [], infra: false },
    execute: async () => run,
    cleanup: async () => {},
    isHealthy: async () => opts.healthy ?? true,
    isReachable: async () => true,
    setupCode: async () => {},
    executeCode: async () => run,
    publishCode: async () => ({ prUrl: "https://github.com/org/panchito/pull/1", merged: true }),
    publishContext: async () => ({ prUrl: "https://github.com/org/demo/pull/2", merged: true }),
    publish: async () =>
      opts.prUrl === null
        ? null
        : { prUrl: opts.prUrl ?? "https://github.com/org/demo/pull/1", merged: true },
    openIssue: async (_repo: string, _title: string, _body: string) => ({
      url: "https://github.com/org/demo/issues/1",
    }),
    saveOutcome: async (outcome: RunOutcome) => {
      savedOutcomes.push(outcome);
    },
    // Stub: returns an empty runOracle result (off-path, never blocks).
    runOracle: async () => ({
      valueScore: 0.85,
      mutantCount: 100,
      killedCount: 85,
      details: "85/100 mutants killed (85.0%)",
    }),
  };

  // Context mode needs validateContextFn wired.
  if (opts.isContext) {
    base.validateContextFn = () => ({ ok: true, errors: [] });
  }

  return base;
}

// ── Public builder ─────────────────────────────────────────────────────────────

export function buildScenarioDeps(key: ScenarioKey): {
  app: AppConfig;
  sha: string;
  source: "manual" | "webhook";
  opts: { mode: RunMode; target?: TestTarget; runId: string; triggerRepo?: string };
  deps: CaptureDeps;
} {
  switch (key) {
    case "green-pr":
      // Source: "green opens a PR, NOT an Issue" — L580
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-green-pr" },
        deps: makeDeps({}),
      };

    case "fail-issue":
      // Source: "on failure opens an Issue with the SHA and does NOT publish" — L596
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-fail-issue" },
        deps: makeDeps({
          run: { sha: "s", verdict: "fail", passed: false, cases: [{ name: "login", status: "fail" }], logs: "x" },
        }),
      };

    case "flaky-quarantine":
      // Source: "flaky: neither PR nor Issue (quarantine)" — L608
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-flaky-quarantine" },
        deps: makeDeps({
          run: { sha: "s", verdict: "flaky", passed: false, cases: [{ name: "checkout", status: "flaky" }], logs: "" },
        }),
      };

    case "no-op-skip":
      // Source: "agent writes no specs (no-op change): skipped" — L568
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-no-op-skip" },
        deps: makeDeps({ agent: noopAgent }),
      };

    case "invalid-issue":
      // Source: "invalid specs: does NOT execute or publish, opens a validation Issue" — L619
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-invalid-issue" },
        deps: makeDeps({
          validation: { ok: false, errors: ["[lint] no-wait-for-timeout"], infra: false },
        }),
      };

    case "infra-error":
      // Source: "DEV unhealthy before execution: infra-error" — L1006
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-infra-error" },
        deps: makeDeps({ healthy: false }),
      };

    case "code-mode":
      // Source: "code mode green: no gate/validate/health" — L1112
      return {
        app: codeApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", target: "code", runId: "golden-code-mode" },
        deps: makeDeps({ isCodeMode: true }),
      };

    case "cross-repo": {
      // Source: "cross-repo: service trigger prepares BOTH mirrors" — L1759
      const d = makeDeps({ isCrossRepo: true });
      // Cross-repo: patch prepare and prepareAtBranch to handle the mirror routing.
      d.prepare = async (_repo: string, _sha: string) => ({
        mirrorDir: "/tmp/golden-svc",
        diff: "diff --git a/src/x.ts b/src/x.ts\n+const x = 1;",
        message: "feat: svc",
      });
      d.prepareAtBranch = async (_repo: string, _branch: string) => ({
        mirrorDir: "/tmp/golden-front",
      });
      d.waitForDeploy = async () => {};
      return {
        app: crossApp,
        sha: "a1b2c3d",
        source: "webhook",
        opts: { mode: "diff", runId: "golden-cross-repo", triggerRepo: "org/orders-svc" },
        deps: d,
      };
    }

    case "shadow":
      // Source: "shadow mode: on green does NOT publish, only logs" — L1072
      return {
        app: shadowApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-shadow" },
        deps: makeDeps({}),
      };

    case "context": {
      // Source: "context mode: generates context.json, validates it, publishes" — L1187
      const d = makeDeps({ isContext: true });
      d.generate = async () => ({
        output: "context map built",
        specs: [".qa/context.json"],
        reviewed: false,
        approved: true,
        note: "built map with 3 routes, 2 api ops, 2 links",
      });
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "context", runId: "golden-context" },
        deps: d,
      };
    }
  }
}

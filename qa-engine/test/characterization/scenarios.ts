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
//
// Plan 6, Slice B.2 additions (widen the parity net — see docs/superpowers/plans/
// 2026-07-01-qa-engine-plan-6-addendum.md). Each new case mirrors a DISTINCT decide-logic branch
// beyond the 10 scenarios above (coverage signal/enforce boundaries, FixLoop retry counts,
// adjudicator classes, a Pillar-2 pre-exec block, a code-mode-specific infra path, and a
// context-mode invalid path) — never a trivial variation of an already-covered branch:
//   static-repair-recovers   → "static-repair loop: a failing static gate regenerates and
//                               re-validates instead of dying invalid on the first miss" (~L633)
//   coverage-enforce-blocks  → "change-coverage enforce: low coverage that can't be improved
//                               blocks publish, opens an Issue" (~L913)
//   coverage-enforce-improves → "change-coverage enforce: the improvement closes the gap →
//                                publishes" (~L924)
//   coverage-enforce-unknown → "change-coverage enforce: unmeasured coverage (null) is 'unknown'
//                               and never blocks" (~L935)
//   fixloop-maxretries-zero  → "3.2 fix-loop: maxRetries=0 disables the fix-loop entirely" (~L2078)
//   adjudicator-app-defect   → "adjudicator: app_defect evidence → Issue filed, verdict=fail" (~L3129)
//   adjudicator-runner-infra → "adjudicator: runner_infra evidence → infra-error verdict, NO repo
//                               Issue" (~L3181)
//   adjudicator-ambiguous-break → "adjudicator: ambiguous + spend=false → break-needs-human →
//                                  labeled Issue, no extra generate" (~L3262)
//   w2-preexec-block         → "W2 pre-exec: a strict-mode ambiguity that PERSISTS after the
//                               corrective regen blocks as invalid" (~L3448)
//   codemode-infra-toolchain → "code mode compile gate: a broken toolchain (infra) → infra-error,
//                               no Issue, no execute" (~L1178)
//   context-invalid          → "context mode: invalid context.json returns 'invalid' verdict and
//                               opens an Issue" (~L1320)

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

// Slice B.2: additional scenarios, kept in a SEPARATE union (not folded into ScenarioKey) so GATE
// A's locked "10 goldens" invariant (golden-parity.test.ts) is untouched — these replay ONLY
// through golden-outcome.harness.ts, never through golden-parity.test.ts/capture-goldens.ts.
export type ScenarioKeyB2 =
  | "static-repair-recovers"
  | "coverage-enforce-blocks"
  | "coverage-enforce-improves"
  | "coverage-enforce-unknown"
  | "fixloop-maxretries-zero"
  | "adjudicator-app-defect"
  | "adjudicator-runner-infra"
  | "adjudicator-ambiguous-break"
  | "w2-preexec-block"
  | "codemode-infra-toolchain"
  | "context-invalid";

// Captures every saved outcome — mirrors pipeline.test.ts's d.savedOutcomes.
// mirrorDir mirrors pipeline.test.ts's Harness.mirrorDir (the working-copy dir prepare() returns) —
// exposed so a Slice B.2 scenario can write a spec file into e2e/ before the run, exactly like the
// pipeline.test.ts adjudicator/W1/W2 tests do via d.mirrorDir.
export interface CaptureDeps extends PipelineDeps {
  savedOutcomes: RunOutcome[];
  mirrorDir?: string;
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
    mirrorDir,

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

// ── Plan 6, Slice B.2 — widened parity net ──────────────────────────────────────
// Shared fixtures mirroring pipeline.test.ts's DIFF_4/cov()/covApp() helpers exactly (do NOT
// invent behavior — same unified-diff shape, same changed-line count, same coverage mode/minRatio
// shape as the source tests).
const DIFF_4 = ["diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "@@ -0,0 +1,4 @@", "+a", "+b", "+c", "+d"].join("\n");
const cov = (lines: number[]): Map<string, Set<number>> => new Map([["src/x.ts", new Set(lines)]]);

const covApp = (mode: "off" | "signal" | "enforce", minRatio = 0.7): AppConfig => ({
  ...scenarioApp,
  qa: { ...scenarioApp.qa, changeCoverage: { mode, minRatio } },
});

const noFixAgent: AgentResult = { output: "x", specs: [], reviewed: true, approved: true };

function failing(names: string[]): QaRunResult {
  return { sha: "s", verdict: "fail", passed: false, cases: names.map((n) => ({ name: n, status: "fail" as const })), logs: "" };
}

export function buildScenarioDepsB2(key: ScenarioKeyB2): {
  app: AppConfig;
  sha: string;
  source: "manual" | "webhook";
  opts: { mode: RunMode; target?: TestTarget; runId: string };
  deps: CaptureDeps;
} {
  switch (key) {
    case "static-repair-recovers": {
      // Source: "static-repair loop: a failing static gate regenerates and re-validates instead of
      // dying invalid on the first miss" — L633. A single trivial static-gate error is repaired on
      // the regen round instead of killing the run invalid on the first miss.
      const d = makeDeps({});
      let n = 0;
      d.validate = async () =>
        n++ === 0
          ? { ok: false, errors: ["39:11  error  'specialtyCell' is assigned a value but never used"], infra: false }
          : { ok: true, errors: [], infra: false };
      return {
        app: scenarioApp,
        sha: "abc1234def",
        source: "manual",
        opts: { mode: "diff", runId: "golden-static-repair-recovers" },
        deps: d,
      };
    }

    case "coverage-enforce-blocks": {
      // Source: "change-coverage enforce: low coverage that can't be improved blocks publish,
      // opens an Issue" — L913. The improvement attempt produces no new specs, so the gap cannot
      // close → enforce mode blocks the publish and opens an Issue. DIFF_4 (a real 4-changed-line
      // unified diff) is REQUIRED so change-coverage has something to measure a gap against — the
      // default 1-line makeDeps() diff would trivially satisfy the ratio and never trip enforce.
      let genCall = 0;
      let covCall = 0;
      const d = makeDeps({});
      const origPrepare = d.prepare!;
      d.prepare = async (repo, sha) => ({ ...(await origPrepare(repo, sha)), diff: DIFF_4 });
      d.generate = async (input) => {
        genCall++;
        return genCall === 1
          ? { output: "spec", specs: ["a.spec.ts"], reviewed: true, approved: true }
          : noFixAgent;
      };
      d.collectCoverage = async () => {
        covCall++;
        return cov([1]); // 1/4 changed lines, never closes the gap
      };
      return {
        app: covApp("enforce"),
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-coverage-enforce-blocks" },
        deps: d,
      };
    }

    case "coverage-enforce-improves": {
      // Source: "change-coverage enforce: the improvement closes the gap → publishes" — L924. The
      // second collectCoverage (after the improvement regen) reports full coverage → publishes.
      // DIFF_4 required for the same reason as coverage-enforce-blocks above.
      let genCall = 0;
      let covCall = 0;
      const d = makeDeps({});
      const origPrepare = d.prepare!;
      d.prepare = async (repo, sha) => ({ ...(await origPrepare(repo, sha)), diff: DIFF_4 });
      d.generate = async (input) => {
        genCall++;
        return { output: "spec", specs: ["a.spec.ts"], reviewed: true, approved: true };
      };
      d.collectCoverage = async () => {
        covCall++;
        return covCall === 1 ? cov([1]) : cov([1, 2, 3, 4]);
      };
      return {
        app: covApp("enforce"),
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-coverage-enforce-improves" },
        deps: d,
      };
    }

    case "coverage-enforce-unknown": {
      // Source: "change-coverage enforce: unmeasured coverage (null) is 'unknown' and never
      // blocks" — L935. Unmeasured coverage (null) must never block, even in enforce mode.
      const d = makeDeps({});
      const origPrepare = d.prepare!;
      d.prepare = async (repo, sha) => ({ ...(await origPrepare(repo, sha)), diff: DIFF_4 });
      d.collectCoverage = async () => null;
      return {
        app: covApp("enforce"),
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-coverage-enforce-unknown" },
        deps: d,
      };
    }

    case "fixloop-maxretries-zero": {
      // Source: "3.2 fix-loop: maxRetries=0 disables the fix-loop entirely (no fix-loop retry
      // execute)" — L2078. A permanently-failing run with maxRetries=0 never retries; verdict
      // stays fail on the single verdictual execute.
      const d = makeDeps({ run: failing(["x"]) });
      d.execute = async () => failing(["x"]);
      return {
        app: {
          ...scenarioApp,
          qa: { ...scenarioApp.qa, fixLoop: { maxRetries: 0 } },
        },
        sha: "abc123",
        source: "manual",
        opts: { mode: "complete", runId: "golden-fixloop-maxretries-zero" },
        deps: d,
      };
    }

    case "adjudicator-app-defect": {
      // Source: "adjudicator: app_defect evidence → Issue filed, verdict=fail" — L3129. A locator
      // failure with an extractable+unique locator and a mismatched-heading detail routes the
      // adjudicator to app_defect: verdict stays fail, an Issue is filed.
      const failureDom = ["heading: Owners", "button: Add Owner"].join("\n");
      const failingRun: QaRunResult = {
        sha: "s",
        verdict: "fail",
        passed: false,
        cases: [
          {
            name: "owners › create",
            status: "fail",
            detail:
              'Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByRole(\'heading\')\nExpected string: "Find Owners"\nReceived string: "Owners"\nTimeout:  5000ms',
            failureDom,
          },
        ],
        logs: "",
      };
      const d = makeDeps({ run: failingRun });
      d.execute = async () => failingRun;
      return {
        app: {
          ...scenarioApp,
          qa: { ...scenarioApp.qa, needsReview: false, fixLoop: { maxRetries: 1 } },
        },
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-adjudicator-app-defect" },
        deps: d,
      };
    }

    case "adjudicator-runner-infra": {
      // Source: "adjudicator: runner_infra evidence → infra-error verdict, NO repo Issue" — L3181.
      // A Playwright-runner-infra failure detail (browser executable missing) routes the
      // adjudicator to runner_infra: verdict becomes infra-error, no Issue is filed.
      const failingRun: QaRunResult = {
        sha: "s",
        verdict: "fail",
        passed: false,
        cases: [
          {
            name: "owners › create",
            status: "fail",
            detail: "browserType.launch: Executable doesn't exist at /usr/bin/chromium",
          },
        ],
        logs: "",
      };
      const d = makeDeps({ run: failingRun });
      d.execute = async () => failingRun;
      return {
        app: {
          ...scenarioApp,
          qa: { ...scenarioApp.qa, needsReview: false, fixLoop: { maxRetries: 1 } },
        },
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-adjudicator-runner-infra" },
        deps: d,
      };
    }

    case "adjudicator-ambiguous-break": {
      // Source: "adjudicator: ambiguous + spend=false → break-needs-human → labeled Issue, no
      // extra generate" — L3262. Two retries with an IDENTICAL failing case (no progress) →
      // decideProgress returns false → rule 5 (break-needs-human) fires: verdict fail, Issue filed.
      const failingRun: QaRunResult = {
        sha: "s",
        verdict: "fail",
        passed: false,
        cases: [
          {
            name: "owners › create",
            status: "fail",
            detail: "strict mode violation: locator found 2 elements",
          },
        ],
        logs: "",
      };
      const d = makeDeps({ run: failingRun });
      d.execute = async () => failingRun;
      return {
        app: {
          ...scenarioApp,
          qa: { ...scenarioApp.qa, needsReview: false, fixLoop: { maxRetries: 2 } },
        },
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-adjudicator-ambiguous-break" },
        deps: d,
      };
    }

    case "w2-preexec-block": {
      // Source: "W2 pre-exec: a strict-mode ambiguity that PERSISTS after the corrective regen
      // blocks as invalid (no execute, no publish)" — L3448. captureRouteTrees ALWAYS reports a
      // duplicate-node ambiguity and the stub generate never scopes the locator, so the
      // deterministic pre-exec block holds the run BEFORE execution — a genuinely distinct
      // "invalid" gate from the static-validate one already covered by the "invalid-issue" golden.
      const d = makeDeps({});
      d.captureRouteTrees = async () => [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }];
      writeFileSync(
        join(d.mirrorDir!, "e2e", "a.spec.ts"),
        `import { test } from "./fixtures";\ntest("owners", async ({ page }) => {\n  await page.goto("/owners");\n  await page.getByRole("heading", { name: "Owners" }).click();\n});\n`,
      );
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", runId: "golden-w2-preexec-block" },
        deps: d,
      };
    }

    case "codemode-infra-toolchain": {
      // Source: "code mode compile gate: a broken toolchain (infra) → infra-error, no Issue, no
      // execute" — L1178. A code-mode-specific infra-error path (the compile gate reports
      // infra:true), distinct from the e2e DEV-unhealthy infra-error already covered by the
      // "infra-error" golden.
      const d = makeDeps({ isCodeMode: true });
      d.validateCode = async () => ({
        ok: false,
        errors: ["[compile] Error: JAVA_HOME is not set and could not be found."],
        infra: true,
      });
      return {
        app: codeApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "diff", target: "code", runId: "golden-codemode-infra-toolchain" },
        deps: d,
      };
    }

    case "context-invalid": {
      // Source: "context mode: invalid context.json returns 'invalid' verdict and opens an
      // Issue" — L1320. A distinct verdict from the clean-pass "context" golden: the agent builds
      // a map but it fails validation, so context mode returns invalid and files an Issue.
      const d = makeDeps({ isContext: true });
      d.generate = async () => ({ output: "tried", specs: [".qa/context.json"], reviewed: false, approved: true });
      d.validateContextFn = () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] });
      return {
        app: scenarioApp,
        sha: "abc123",
        source: "manual",
        opts: { mode: "context", runId: "golden-context-invalid" },
        deps: d,
      };
    }
  }
}

// qa-engine/src/contexts/test-execution/application/ports/index.ts
// The deterministic harness ports. ExecutionStrategyPort [SWAP — two adapters: e2e/code] is lifted
// from execute.ts ExecuteDeps; the static gate from validate.ts ValidateDeps. DeployGatePort is
// kernel-resident (Task 8) — consumed here via @kernel, not defined locally. ProcessKillPort is
// consumed FROM the kernel (breaks the execute ⇄ dom-snapshot cycle). CheckResult is a local result
// type (mirrors src/qa CheckResult).

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";

// DeployGatePort is a cross-cutting infra port defined in the kernel. [SWAP] adapter is absent for
// static sites and the code target (returns ok(true) immediately).
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";

export interface CheckResult { ok: boolean; output: string; infra?: boolean; } // infra optional: mirrors src/qa/validate.ts CheckResult (infra?: boolean)
export interface ExecutionRequest {
  specDir: string;
  baseUrl?: string;        // absent for code target
  namespace: string;
  faultInject?: boolean;
  specFiles?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ExecutionResult { verdict: RunVerdict; cases: QaCase[]; logs: string; }

// [SWAP — e2e (Playwright) vs code (exit-code)].
export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}
// Static gate (tsc/eslint-playwright/playwright --list/manifest) — lifted from ValidateDeps.
export interface StaticGatePort {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
}

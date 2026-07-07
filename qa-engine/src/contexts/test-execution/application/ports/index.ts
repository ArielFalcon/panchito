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

// ValidationResult mirrors src/qa/validate.ts ValidationResult. Re-exported here so that
// consumers of the port (Plan-6 orchestration layer) import from the port, not from src/.
export interface ValidationResult {
  ok: boolean;
  errors: string[]; // one error per failed check, with its output (for the agent)
  infra: boolean;   // ALL failures are infrastructure (missing tools, OOM) — not code quality
}
export interface ExecutionRequest {
  specDir: string;
  baseUrl?: string;        // absent for code target
  namespace: string;
  faultInject?: boolean;
  specFiles?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  // injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId against the app's convention
  testIdAttribute?: string;
  // e2e live-progress callbacks (ExecuteOptions capability set — no regression vs legacy):
  project?: string;                                          // Playwright --project filter
  onCase?: (c: { name: string; status: string; detail?: string }) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  // code target: diff-driven module scoping (CodeExecuteOptions.changedFiles):
  changedFiles?: string[];
}
export interface ExecutionResult { verdict: RunVerdict; cases: QaCase[]; logs: string; }

// [SWAP — e2e (Playwright) vs code (exit-code)].
export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

// WS2.2 (full-flow remediation, code-mode restoration): Filter B for the CODE target — a
// compile-feedback gate, ported from src/qa/code-validate.ts's validateCodeProject (legacy had
// this; qa-engine never wired it — the code target previously had NO pre-execution feedback at
// all). [SWAP — StaticGateAdapter (e2e: tsc/eslint-playwright/playwright --list/manifest) vs this
// (code: per-ecosystem compile-only command, e.g. `mvn test-compile`/`tsc --noEmit`/`go vet`)].
// Returns the SAME ValidationResult shape StaticGatePort.validateAll does, so ValidationPortAdapter
// can dispatch between the two without widening RunQaUseCase's own validation.validate() contract.
export interface CodeValidatePort {
  validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult>;
}
// Static gate (tsc/eslint-playwright/playwright --list/manifest) — lifted from ValidateDeps.
// validateAll runs the FULL gate (all 4 checks + the zero-assertion guard) in one call, matching
// the behavior of the legacy validateSpecs. Consumers that call validateAll cannot silently skip
// the zero-assertion guard (WF-02). The 4 granular methods remain for fine-grained injection.
export interface StaticGatePort {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
  validateAll(specDir: string): Promise<ValidationResult>;
}

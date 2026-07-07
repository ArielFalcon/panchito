// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.ts
// Bridge: ValidationPort -> test-execution's REAL target-dispatched gates. THIN — no new policy.
// e2e delegates to StaticGateAdapter.validateAll(specDir), the FULL gate (tsc/eslint-playwright/
// playwright --list/manifest/zero-assertion guard, WF-02) — never the 4 granular methods, which
// would silently skip the zero-assertion guard (StaticGateAdapter's own header warning).
//
// WS2.2 (full-flow remediation, code-mode restoration): TARGET-DISPATCHED, the SAME {e2e, code} +
// {target} collaborator/context pattern ExecutionPortAdapter/SetupPortAdapter already establish
// (mirrors those two adapters' exact shape — this is the third port needing target-aware dispatch,
// not a new pattern). The code branch delegates to CodeValidationStrategy (Filter B for CODE mode —
// the compile-feedback gate ported from src/qa/code-validate.ts, never wired into qa-engine before
// this fix: the code target previously reached execution with zero pre-execution feedback).
import type { ValidationPort } from "../../application/ports/index.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export interface ValidationPortStrategies {
  e2e: StaticGateAdapter;
  code: CodeValidationStrategy;
}

export interface ValidationPortStaticContext {
  target: TestTarget;
}

export class ValidationPortAdapter implements ValidationPort {
  constructor(
    private readonly strategies: ValidationPortStrategies,
    private readonly ctx: ValidationPortStaticContext,
  ) {}

  async validate(specDir: string, changedFiles?: string[]): Promise<{ ok: boolean; errors: string[]; infra?: boolean }> {
    const result =
      this.ctx.target === "code"
        ? await this.strategies.code.validate(specDir, changedFiles)
        : await this.strategies.e2e.validateAll(specDir);
    return { ok: result.ok, errors: result.errors, infra: result.infra };
  }
}

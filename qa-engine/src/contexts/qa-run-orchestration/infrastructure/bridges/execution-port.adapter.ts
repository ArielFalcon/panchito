// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts
// Bridge: ExecutionPort -> the REAL e2e/code strategy dispatch. THIN — no new policy: this bridge
// only maps ExecutionPort.execute(specDir) onto ExecutionRequest (baseUrl/namespace held as static
// per-run context, matching the same constructor-config pattern GenerationPortAdapter uses) and
// selects the strategy by target — the strategies themselves (E2eExecutionStrategy /
// CodeExecutionStrategy) own the ENTIRE run/adjudicate logic, reused verbatim.
import type { ExecutionPort } from "../../application/ports/index.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export interface ExecutionPortStrategies {
  e2e: E2eExecutionStrategy;
  code: CodeExecutionStrategy;
}

export interface ExecutionPortStaticContext {
  target: TestTarget;
  namespace: string;
  baseUrl?: string; // required for target:"e2e"; absent for target:"code"
}

export class ExecutionPortAdapter implements ExecutionPort {
  constructor(
    private readonly strategies: ExecutionPortStrategies,
    private readonly ctx: ExecutionPortStaticContext,
  ) {}

  async execute(specDir: string): ReturnType<ExecutionPort["execute"]> {
    if (this.ctx.target === "code") {
      return this.strategies.code.run({ specDir, namespace: this.ctx.namespace });
    }
    return this.strategies.e2e.run({
      specDir,
      namespace: this.ctx.namespace,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
    });
  }
}

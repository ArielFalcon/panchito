// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts
// Bridge: ExecutionPort -> the REAL e2e/code strategy dispatch. THIN — no new policy: this bridge
// only maps ExecutionPort.execute(specDir, signal?) onto ExecutionRequest (baseUrl/namespace held
// as static per-run context, matching the same constructor-config pattern GenerationPortAdapter
// uses) and selects the strategy by target — the strategies themselves (E2eExecutionStrategy /
// CodeExecutionStrategy) own the ENTIRE run/adjudicate logic, reused verbatim.
//
// Plan 7.2 (closes engram #916): signal is forwarded verbatim into ExecutionRequest.signal — both
// strategies already forward it into runE2E/runCodeTests's own opts.signal (Plan 7.1 territory,
// untouched here); this bridge was the ONLY missing link, silently dropping a cancelled run's
// signal before it ever reached the wall-clock-dominant Playwright/code-runner call.
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

  async execute(specDir: string, signal?: AbortSignal): ReturnType<ExecutionPort["execute"]> {
    if (this.ctx.target === "code") {
      return this.strategies.code.run({
        specDir,
        namespace: this.ctx.namespace,
        ...(signal ? { signal } : {}),
      });
    }
    return this.strategies.e2e.run({
      specDir,
      namespace: this.ctx.namespace,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts
// Bridge: ExecutionPort -> the REAL e2e/code strategy dispatch. THIN — no new policy: this bridge
// only maps ExecutionPort.execute(specDir, opts?) onto ExecutionRequest (baseUrl/namespace held
// as static per-run context, matching the same constructor-config pattern GenerationPortAdapter
// uses) and selects the strategy by target — the strategies themselves (E2eExecutionStrategy /
// CodeExecutionStrategy) own the ENTIRE run/adjudicate logic, reused verbatim.
//
// Plan 7.2 (closes engram #916): signal is forwarded verbatim into ExecutionRequest.signal — both
// strategies already forward it into runE2E/runCodeTests's own opts.signal (Plan 7.1 territory,
// untouched here); this bridge was the ONLY missing link, silently dropping a cancelled run's
// signal before it ever reached the wall-clock-dominant Playwright/code-runner call.
//
// W4 fix (F1): opts now accepts the full ExecutionOpts bag (faultInject/specFiles/project/
// timeoutMs/onCase/onRunning/onDiscovered), not just signal — spread verbatim into
// ExecutionRequest, which both strategies already forward into runE2E/runCodeTests's own opts
// (test-execution/infrastructure/e2e-execution.strategy.ts). Backward compat: a bare AbortSignal
// (the pre-existing 2nd positional arg shape) is normalized to `{ signal }` first — every caller
// written against `execute(specDir, signal?)` keeps compiling and behaving identically.
//
// P2 (post-cutover-remediation) Constraint 2: opts.namespace, when present, OVERRIDES the static
// ctx.namespace in BOTH the code and e2e branches — the enforce-mode coverage regen executes+
// re-measures under a dedicated `${runId}-coverage-regen` namespace so its dumps never collide
// with the first run's. Absent -> falls back to ctx.namespace (unchanged, backward compatible).
import type { ExecutionPort, ExecutionOpts } from "../../application/ports/index.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import type { TestTarget } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface ExecutionPortStrategies {
  e2e: E2eExecutionStrategy;
  code: CodeExecutionStrategy;
}

export interface ExecutionPortStaticContext {
  target: TestTarget;
  namespace: string;
  baseUrl?: string; // required for target:"e2e"; absent for target:"code"
  testIdAttribute?: string; // injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId against the app's convention
}

// AbortSignal is a runtime class instance (has .aborted/.addEventListener); the opts bag is a
// plain object literal — the two 2nd-arg shapes are unambiguous to distinguish at runtime.
function normalizeOpts(opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts {
  if (!opts) return {};
  if (opts instanceof AbortSignal) return { signal: opts };
  return opts;
}

export class ExecutionPortAdapter implements ExecutionPort {
  constructor(
    private readonly strategies: ExecutionPortStrategies,
    private readonly ctx: ExecutionPortStaticContext,
  ) {}

  async execute(specDir: string, opts?: AbortSignal | ExecutionOpts): ReturnType<ExecutionPort["execute"]> {
    const o = normalizeOpts(opts);
    if (this.ctx.target === "code") {
      // specFiles (E2E-only filtered-retry concept — see ExecutionOpts's own header) is
      // deliberately NOT forwarded here: FixLoop.run's own code-mode branch never passes it
      // (fix-loop.aggregate.ts: `this.deps.execution.execute({ namespace: input.namespace })`,
      // no specFiles), and CodeExecutionStrategy's own diff-driven module scoping is a DIFFERENT
      // concept (ExecutionRequest.changedFiles — which files CHANGED, not which specs FAILED).
      return this.strategies.code.run({
        specDir,
        namespace: o.namespace ?? this.ctx.namespace,
        ...(o.signal ? { signal: o.signal } : {}),
      });
    }
    return this.strategies.e2e.run({
      specDir,
      namespace: o.namespace ?? this.ctx.namespace,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(this.ctx.testIdAttribute !== undefined ? { testIdAttribute: this.ctx.testIdAttribute } : {}),
      ...(o.faultInject !== undefined ? { faultInject: o.faultInject } : {}),
      ...(o.specFiles ? { specFiles: o.specFiles } : {}),
      ...(o.project !== undefined ? { project: o.project } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      // onCase: ExecutionRequest's own callback param is a structurally-narrower LOCAL shape
      // ({name; status: string; detail?}, test-execution/application/ports/index.ts) than the
      // kernel QaCase ExecutionOpts.onCase declares (status: CaseStatus) — E2eExecutionStrategy
      // passes the REAL QaCase through at runtime (its own header: "cases are already kernel
      // QaCase directly"), so this is a type-level widening only, never a runtime behavior change.
      ...(o.onCase ? { onCase: (c: { name: string; status: string; detail?: string }) => o.onCase!(c as QaCase) } : {}),
      ...(o.onRunning ? { onRunning: o.onRunning } : {}),
      ...(o.onDiscovered ? { onDiscovered: o.onDiscovered } : {}),
    });
  }
}

// src/contexts/test-execution/infrastructure/code-execution.strategy.ts
// WRAP of the code target (src/qa/code-runner.ts runCodeTests + detectCodeProject): exit-code
// classify, no browser, no flaky, no deploy gate. The run fn is injected so the adapter tests
// run without installing the watched repo's deps. Delegates — does not reimplement detection.
//
// Plan-6 wiring note: the real composition passes
//   (repoDir, opts) => runCodeTests(repoDir, opts, defaultCodeExecuteDeps)
// as the RunCodeFn. The injected seam keeps this adapter binary-free for testing.
import type { ExecutionStrategyPort, ExecutionRequest, ExecutionResult } from "../application/ports/index.ts";

// Structural shape of the legacy QaRunResult fields this adapter reads. Declared locally so
// this file does not import from src/ (only the parity test may). Widened: optional fields omitted.
interface LegacyCodeResult {
  verdict: string;
  cases: { name: string; status: string; detail?: string }[];
  logs: string;
}

// The injected fn signature mirrors runCodeTests(repoDir, opts, deps) -> QaRunResult, narrowed to
// the fields the adapter needs. changedFiles threads CodeExecuteOptions.changedFiles for diff-driven
// module scoping (narrows the test command to the changed module on monorepos).
type RunCodeFn = (
  repoDir: string,
  opts: {
    namespace: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    changedFiles?: string[]; // CodeExecuteOptions.changedFiles: diff-driven module scoping
  },
) => Promise<LegacyCodeResult>;

export class CodeExecutionStrategy implements ExecutionStrategyPort {
  constructor(private readonly runCode: RunCodeFn) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const result = await this.runCode(req.specDir, {
      namespace: req.namespace,
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      // Thread changedFiles for diff-driven module scoping (CodeExecuteOptions.changedFiles):
      ...(req.changedFiles ? { changedFiles: req.changedFiles } : {}),
    });
    const cases = result.cases.map((c) => ({
      name: c.name,
      status: c.status as "pass" | "fail" | "flaky",
      ...(c.detail ? { detail: c.detail } : {}),
    }));
    return { verdict: result.verdict as ExecutionResult["verdict"], cases, logs: result.logs };
  }
}

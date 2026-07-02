// src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts
// WRAP of src/qa/execute.ts runE2E (strangler: delegate, do not rewrite the runner). Maps the
// typed ExecutionRequest onto the legacy opts and the legacy QaRunResult onto ExecutionResult,
// then runs it through AdjudicateService so the runner-infra reclassification is centralized.
// The runE2E fn is injected so this adapter is testable without Playwright.
//
// Defense-in-depth note: AdjudicateService is applied here on top of runE2E, which already
// performs the same reclassification internally (allFailuresAreRunnerInfra in execute.ts).
// The double-pass is intentional and idempotent — adjudicate(adjudicate(verdict)) == adjudicate(verdict)
// because infra-error is a terminal verdict that the service returns unchanged. This ensures the
// typed boundary always carries a correctly-classified verdict regardless of whether the injected
// runE2E stub (in tests) or the real runner performed the internal reclassification.
//
// Plan-6 composition wiring: pass (specDir, opts) => runE2E(specDir, opts, defaultExecuteDeps).
import type {
  ExecutionStrategyPort,
  ExecutionRequest,
  ExecutionResult,
} from "../application/ports/index.ts";
import { AdjudicateService } from "../domain/adjudicate.service.ts";

// Structural shape of the legacy runE2E return (src/types.ts QaRunResult) — declared locally so
// this file does not import from src/ (only the parity test may). Mirrors kernel QaCase (@kernel/
// qa-case.ts) field-for-field: G1 widened the kernel type precisely so this evidence — failureDom/
// httpStatus/finalUrl/runtimeErrors/file/durationMs/flow/objective/reason — survives the port
// boundary instead of being re-projected away. The FixLoop aggregate reads these fields off QaCase
// for adjudicator Rules 2.5/2.6 and Lever-2; dropping them here silently starved that logic.
interface LegacyRunResult { verdict: string; cases: QaCase[]; logs: string; }
type QaCase = {
  name: string;
  status: string;
  detail?: string;
  flow?: string;
  objective?: string;
  reason?: string;
  durationMs?: number;
  failureDom?: string;
  file?: string;
  httpStatus?: number;
  finalUrl?: string;
  runtimeErrors?: { type: string; text: string }[];
};
type RunE2eFn = (
  specDir: string,
  opts: {
    baseUrl: string;
    namespace: string;
    faultInject?: boolean;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    // Carries the full ExecuteOptions capability set — no regression vs the legacy seam:
    project?: string;                          // Playwright --project (PW_PROJECT_RE validated by runE2E)
    onCase?: (c: QaCase) => void;              // per-test completion (live bar / history)
    onRunning?: (title: string) => void;       // test started (focus card)
    onDiscovered?: (title: string, file?: string) => void; // full test list up-front
  },
) => Promise<LegacyRunResult>;

export class E2eExecutionStrategy implements ExecutionStrategyPort {
  private readonly adjudicator = new AdjudicateService();
  constructor(private readonly runE2E: RunE2eFn) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    if (!req.baseUrl) throw new Error("E2eExecutionStrategy requires a baseUrl (live DEV URL)");
    const result = await this.runE2E(req.specDir, {
      baseUrl: req.baseUrl,
      namespace: req.namespace,
      ...(req.faultInject !== undefined ? { faultInject: req.faultInject } : {}),
      ...(req.specFiles ? { specFiles: req.specFiles } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      // Thread the full ExecuteOptions capability set — no capability regression vs legacy seam:
      ...(req.project !== undefined ? { project: req.project } : {}),
      ...(req.onCase ? { onCase: req.onCase } : {}),
      ...(req.onRunning ? { onRunning: req.onRunning } : {}),
      ...(req.onDiscovered ? { onDiscovered: req.onDiscovered } : {}),
    });
    // Status-narrowing pass-through: keep every evidence field the runner emitted (no re-projection)
    // and only narrow `status` to the port's literal union.
    const cases = result.cases.map((c) => ({ ...c, status: c.status as "pass" | "fail" | "flaky" }));
    const adjudged = this.adjudicator.adjudicate(result.verdict as ExecutionResult["verdict"], cases);
    return { verdict: adjudged.verdict, cases, logs: result.logs };
  }
}

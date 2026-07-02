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
import type { QaCase } from "@kernel/qa-case.ts";
import { AdjudicateService } from "../domain/adjudicate.service.ts";

// Structural shape of the legacy runE2E return — the OUTER shape mirrors src/types.ts QaRunResult
// and stays locally declared: the rule for this file is NO src/ imports (only the parity test may);
// kernel imports are allowed and expected. Cases are kernel QaCase directly (src/types.ts CaseStatus
// is the identical union, so nothing the legacy runner emits is narrowed away) — the G1-widened
// evidence (failureDom/httpStatus/finalUrl/runtimeErrors/file/durationMs/flow/objective/reason)
// survives the port boundary by construction, with no hand-synced mirror left to drift. The FixLoop
// aggregate reads these fields off QaCase for adjudicator Rules 2.5/2.6 and Lever-2.
interface LegacyRunResult { verdict: string; cases: QaCase[]; logs: string; }
type RunE2eFn = (
  specDir: string,
  opts: {
    baseUrl: string;
    namespace: string;
    faultInject?: boolean;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    testIdAttribute?: string;                  // injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId against the app's convention
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
      ...(req.testIdAttribute !== undefined ? { testIdAttribute: req.testIdAttribute } : {}),
      // Thread the full ExecuteOptions capability set — no capability regression vs legacy seam:
      ...(req.project !== undefined ? { project: req.project } : {}),
      ...(req.onCase ? { onCase: req.onCase } : {}),
      ...(req.onRunning ? { onRunning: req.onRunning } : {}),
      ...(req.onDiscovered ? { onDiscovered: req.onDiscovered } : {}),
    });
    // Pass-through: cases are already kernel QaCase — every evidence field the runner emitted
    // crosses the boundary untouched (no re-projection, no cast).
    const cases = result.cases;
    const adjudged = this.adjudicator.adjudicate(result.verdict as ExecutionResult["verdict"], cases);
    return { verdict: adjudged.verdict, cases, logs: result.logs };
  }
}

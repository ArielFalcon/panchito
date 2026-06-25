// qa-engine/src/shared-kernel/run-verdict.ts
// The six-verdict test outcome and the user-facing engine status derived from it. Carried VERBATIM
// from src/types.ts (this is now the single source of truth; the legacy copy stays during Phase-1
// parity). engineStatus answers "did the engine produce a TRUSTWORTHY result?", not "did every test
// pass?": a real bug found (fail → Issue) is SUCCESS; only an unrunnable/un-producible run is ERROR.

export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";

export const RUN_ENGINE_STATUSES = { SUCCESS: "success", ERROR: "error" } as const;
export type RunEngineStatus = (typeof RUN_ENGINE_STATUSES)[keyof typeof RUN_ENGINE_STATUSES];

// Fail-safe: a null/undefined verdict (never recorded, or a wire value that never arrived) is ERROR.
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? RUN_ENGINE_STATUSES.ERROR
    : RUN_ENGINE_STATUSES.SUCCESS;
}

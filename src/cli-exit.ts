import { RunVerdictSchema } from "./contract/events";
import { engineStatus, RUN_ENGINE_STATUSES } from "./types";

// The CLI exit-code decision. A run SUCCEEDED (exit 0) when the engine produced a TRUSTWORTHY
// result — including a real bug found (verdict `fail` → Issue), which previously exited non-zero
// like a crash. Only an engine error (`infra-error`/`invalid`, or no verdict) exits non-zero.
//
// The verdict reaches us either typed (standalone path: RunVerdict | undefined) or as a raw wire
// string (delegated path: string | null). `safeParse` normalizes both and maps anything
// unrecognized/absent to `null`, which `engineStatus` treats as a fail-safe error — an unknown wire
// value never silently counts as success.
export function runSucceeded(verdict: string | null | undefined): boolean {
  const parsed = RunVerdictSchema.safeParse(verdict);
  return engineStatus(parsed.success ? parsed.data : null) === RUN_ENGINE_STATUSES.SUCCESS;
}

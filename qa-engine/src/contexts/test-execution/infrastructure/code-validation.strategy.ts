// qa-engine/src/contexts/test-execution/infrastructure/code-validation.strategy.ts
// Wraps validateCodeProject — Filter B for the CODE target (a compile-feedback gate BEFORE running
// the repo's own suite). Mirrors code-execution.strategy.ts's own DI pattern exactly: the run fn is
// injected so this adapter spawns no real toolchain in tests. Delegates — does not reimplement
// ecosystem detection, compile-command selection, or the toolchain-vs-real-error classification
// (isToolchainFailure); those live in this directory's own static-gate.checks.ts sibling
// (migration-tier-4b Slice 3 — body-moved from src/qa/code-validate.ts, which is now deleted).
//
// WS2.2 (full-flow remediation): legacy's code path had a DEDICATED compile gate
// (src/pipeline.ts:2434-2490's `deps.validateCode` branch) that was never ported into qa-engine —
// the code target previously reached execution with zero pre-execution feedback (a compile error
// surfaced only as an opaque whole-build failure). This strategy closes that gap, wired into
// ValidationPort's code branch (validation-port.adapter.ts).
import type { ValidationResult } from "../application/ports/index.ts";

// The injected fn signature mirrors validateCodeProject(repoDir, deps, opts) -> ValidationResult,
// narrowed to the fields this adapter needs. changedFiles threads the SAME diff-driven scoping
// concept CodeExecutionStrategy's RunCodeFn already documents (module-scoped compile on monorepos);
// absent -> the injected fn falls back to its own working-tree probe (validateCodeProject's own
// `effectiveChangedFiles` fallback), never a crash.
type ValidateCodeFn = (repoDir: string, opts: { changedFiles?: string[] }) => Promise<ValidationResult>;

export class CodeValidationStrategy {
  constructor(private readonly validateCode: ValidateCodeFn) {}

  async validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult> {
    return this.validateCode(specDir, { ...(changedFiles ? { changedFiles } : {}) });
  }
}

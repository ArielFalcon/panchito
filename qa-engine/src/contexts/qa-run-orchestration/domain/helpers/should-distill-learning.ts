// qa-engine/src/contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts
// PORT verbatim from src/pipeline.ts (design §7.2 Step 10). Copy + parity, no logic change. The
// legacy original stays until the Plan 7 cutover; a parity test (should-distill-learning-parity.test.ts)
// pins this copy against it.
import type { RunVerdict } from "@kernel/run-verdict.ts";

// Whether a run's outcome should feed the learning flywheel's rule-distillation. A code-mode `fail`
// means the agent's generated test CORRECTLY caught a real bug — distilling a "fix this test" rule
// would teach the engine to weaken a test that did its job (Goodhart). Suppress distillation for that
// case ONLY; every other verdict (incl. `invalid` — broken generated tests, where the lesson is real)
// still feeds learning. e2e is unaffected.
export function shouldDistillLearning(isCode: boolean, verdict: RunVerdict): boolean {
  return !(isCode && verdict === "fail");
}

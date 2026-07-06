// qa-engine/src/contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts
// PORT verbatim from src/pipeline.ts (design §7.2 Step 10). Copy + parity, no logic change. The
// legacy original stays until the Plan 7 cutover; a parity test (should-distill-learning-parity.test.ts)
// pins this copy against it.
//
// post-cutover-remediation P3 (unit 4): a THIRD, optional arg — the FixLoop's own adjudicator
// verdict class (fix-loop.aggregate.ts's FixLoopResult.lastAdjudicatorVerdict.class, threaded via
// the kernel RunOutcome.adjudication field). Suppress distillation when the adjudicator attributed
// the failure to the APP (app_defect) — same Goodhart rationale as the existing isCode+fail rule,
// now extended to the adjudicator's own classification, in ADDITION to (not instead of) that rule.
// Untyped `string` (not the domain's AdjudicatorClass literal union) — this helper takes whatever
// the kernel's wide `adjudication?.class` field carries, so it never imports the domain type either.
import type { RunVerdict } from "@kernel/run-verdict.ts";

// Whether a run's outcome should feed the learning flywheel's rule-distillation. A code-mode `fail`
// means the agent's generated test CORRECTLY caught a real bug — distilling a "fix this test" rule
// would teach the engine to weaken a test that did its job (Goodhart). Suppress distillation for that
// case; ALSO suppress when the adjudicator classified the failure as `app_defect` specifically (not
// any other adjudication class) — same rationale, extended to the adjudicator's own verdict. Every
// other verdict/class combination (incl. `invalid` — broken generated tests, where the lesson is
// real) still feeds learning. e2e is unaffected by the isCode+fail rule; the app_defect rule applies
// regardless of isCode/verdict.
export function shouldDistillLearning(isCode: boolean, verdict: RunVerdict, adjudicationClass?: string): boolean {
  return !(isCode && verdict === "fail") && adjudicationClass !== "app_defect";
}

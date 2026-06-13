import type { LearningRule } from "../qa/learning/learning-rule";
import type { Scorecard } from "../qa/learning/oracle-types";
import type { Curriculum } from "../qa/learning/curriculum";

// toIntelligenceView projects the persisted learning artifacts into the read-only
// contract shape the operator console renders. It is pure (no I/O), so it is unit-tested
// directly and the orchestrator wires the real history reads at the call site. The
// inferred return must stay structurally compatible with IntelligenceViewSchema — tsc
// catches any drift between this projection and the contract.
export function toIntelligenceView(
  app: string,
  rules: LearningRule[],
  scorecard: Scorecard | null,
  curriculum: Curriculum | null,
) {
  return {
    app,
    rules: rules.map((r) => ({
      trigger: r.trigger,
      action: r.action,
      errorClass: r.errorClass,
      confidence: r.confidence,
      usageCount: r.usageCount,
      outcomeCount: r.outcomeCount,
      successRate: r.successRate,
      status: r.status,
    })),
    scorecard: scorecard && {
      updatedAt: scorecard.updatedAt,
      totalRuns: scorecard.summary.totalRuns,
      measuredRuns: scorecard.summary.measuredRuns,
      avgValueScore: scorecard.summary.avgValueScore,
      lastValueScore: scorecard.summary.lastValueScore,
      // Only the most recent entries are surfaced — the ledger is unbounded.
      entries: scorecard.entries.slice(-10).map((e) => ({
        valueScore: e.valueScore,
        mutantCount: e.mutantCount,
        killedCount: e.killedCount,
        target: e.target,
        at: e.at,
      })),
    },
    curriculum: curriculum && {
      updatedAt: curriculum.updatedAt,
      archetypes: curriculum.archetypes.map((a) => ({
        archetype: a.archetype,
        caughtRealBug: a.caughtRealBug,
        promotionCount: a.promotionCount,
      })),
    },
  };
}

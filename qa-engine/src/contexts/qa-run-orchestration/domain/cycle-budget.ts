// qa-engine/src/contexts/qa-run-orchestration/domain/cycle-budget.ts
// Value object for the regeneration-loop ceiling (MAX_CYCLES) and the running cycleCount, ported
// from the raw `let MAX_CYCLES` / `let cycleCount` locals in src/pipeline.ts (:1072-1078, :1573,
// :2195-2199). Immutable: tick()/raiseTo() return a NEW instance rather than mutating in place,
// so the aggregate holding this VO stays consistent with the Run aggregate's own immutability style.
//
// Derivation mirrors `app.qa.iterationBudget ?? deriveCycleBackstop(maxRetries, numObjectives)`
// EXACTLY (src/pipeline.ts:1072-1073): an explicit iterationBudget config override wins
// unconditionally over the derived backstop.
//
// raiseTo() ports the Phase-6b retroactive bump (src/pipeline.ts:2195-2199): when the planner
// yields multiple objectives, the ceiling is refined to `deriveCycleBackstop(maxRetries,
// numObjectives)` — but ONLY if (a) no iterationBudget override is set (the override always wins,
// mirroring the legacy `if (!app.qa.iterationBudget && ...)` guard) and (b) the refined value is
// STRICTLY GREATER than the current ceiling (raiseTo NEVER lowers — a true backstop never
// truncates legitimate work already budgeted).

import { deriveCycleBackstop } from "./helpers/derive-cycle-backstop.ts";

export interface CycleBudgetInput {
  maxRetries: number;
  iterationBudget?: number;
  numObjectives?: number;
}

export class CycleBudget {
  private constructor(
    readonly ceiling: number,
    readonly cycleCount: number,
    private readonly maxRetries: number,
    private readonly iterationBudgetOverride: number | undefined,
  ) {}

  static derive(input: CycleBudgetInput): CycleBudget {
    const ceiling = input.iterationBudget ?? deriveCycleBackstop(input.maxRetries, input.numObjectives);
    return new CycleBudget(ceiling, 0, input.maxRetries, input.iterationBudget);
  }

  tick(): CycleBudget {
    return new CycleBudget(this.ceiling, this.cycleCount + 1, this.maxRetries, this.iterationBudgetOverride);
  }

  exhausted(): boolean {
    return this.cycleCount > this.ceiling;
  }

  // Ports src/pipeline.ts:2195-2199's scope-dimensioned bump. A no-op (returns an equal-ceiling
  // instance) when an iterationBudget override is set, or when the refined value would not exceed
  // the current ceiling — raiseTo never shrinks the budget.
  raiseTo(numObjectives: number): CycleBudget {
    if (this.iterationBudgetOverride !== undefined) return this;
    const refined = deriveCycleBackstop(this.maxRetries, numObjectives);
    if (refined <= this.ceiling) return this;
    return new CycleBudget(refined, this.cycleCount, this.maxRetries, this.iterationBudgetOverride);
  }
}

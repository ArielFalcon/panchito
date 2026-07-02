// qa-engine/src/contexts/qa-run-orchestration/domain/wall-clock-budget.ts
// Value object for the wall-clock ceiling on a run's total generation time, ported from the raw
// `let wallClockBudget` local in src/pipeline.ts (:1074-1078, :2200-2204, :2362-2365). Immutable:
// recomputeFrom()/extendBy() return a NEW instance.
//
// Derivation mirrors `app.qa.wallClockBudgetMs ?? (MAX_CYCLES * agentTimeout(mode))` EXACTLY
// (src/pipeline.ts:1077): an explicit wallClockBudgetMs config override WINS UNCONDITIONALLY —
// once set, it is NEVER recomputed, whether from a CycleBudget.raiseTo() bump (:2202) or the
// fixCases continuation extension (:2364-2365). This VO takes `agentTimeoutMs` as a plain number
// (the caller resolves `agentTimeout(mode)` at the boundary — this VO stays free of the mode/
// agent-runtime dependency, matching the kernel-isolation discipline used elsewhere in this slice).

import type { CycleBudget } from "./cycle-budget.ts";

export interface WallClockBudgetInput {
  cycleBudget: CycleBudget;
  agentTimeoutMs: number;
  wallClockBudgetMs?: number;
}

export class WallClockBudget {
  private constructor(
    readonly budgetMs: number,
    private readonly agentTimeoutMs: number,
    private readonly override: number | undefined,
  ) {}

  static derive(input: WallClockBudgetInput): WallClockBudget {
    const budgetMs = input.wallClockBudgetMs ?? input.cycleBudget.ceiling * input.agentTimeoutMs;
    return new WallClockBudget(budgetMs, input.agentTimeoutMs, input.wallClockBudgetMs);
  }

  exhausted(elapsedMs: number): boolean {
    return elapsedMs > this.budgetMs;
  }

  // Ports src/pipeline.ts:2200-2204 — recompute against a raised CycleBudget's ceiling ONLY when
  // no override is set. A no-op (returns an equal-budgetMs instance) when an override is present.
  recomputeFrom(cycleBudget: CycleBudget): WallClockBudget {
    if (this.override !== undefined) return this;
    return new WallClockBudget(cycleBudget.ceiling * this.agentTimeoutMs, this.agentTimeoutMs, this.override);
  }

  // Ports src/pipeline.ts:2362-2365 — the fixCases continuation additive extension. A no-op when an
  // override is set (same "override wins unconditionally, never recomputed" invariant).
  extendBy(extraMs: number): WallClockBudget {
    if (this.override !== undefined) return this;
    return new WallClockBudget(this.budgetMs + extraMs, this.agentTimeoutMs, this.override);
  }
}

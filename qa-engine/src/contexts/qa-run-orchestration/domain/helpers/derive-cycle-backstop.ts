// qa-engine/src/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts
// PORT verbatim from src/pipeline.ts (design §7.2 Step 10). Copy + parity, no logic change. The
// legacy original stays until the Plan 7 cutover; a parity test (derive-cycle-backstop-parity.test.ts)
// pins this copy against it. Module-scope constants (MAX_STATIC_FIX_ROUNDS/CYCLES_PER_GENERATE/
// REPAIR_HEADROOM_PER_GENERATE) are copied verbatim alongside the function since deriveCycleBackstop's
// derivation depends on them and there is no shared cross-repo import for pipeline.ts-local constants.

// Regeneration-loop caps, copied verbatim from src/pipeline.ts's module-level constants (the
// original's own comment: "Module-level so the runaway backstop (MAX_CYCLES, derived below) and the
// loops that actually consume them share ONE source of truth — the derivation cannot silently drift
// from the real loop bounds.").
//   MAX_REVIEW_ROUNDS    — reviewer reject→regenerate rounds inside one generateAndReview().
//   MAX_STATIC_FIX_ROUNDS — static-gate (Filter B) repair rounds (tsc/eslint/list).
const MAX_REVIEW_ROUNDS = 2;
const MAX_STATIC_FIX_ROUNDS = 2;

// Each generateAndReview() costs at most CYCLES_PER_GENERATE counter ticks: 1 for the entry
// invocation + up to (MAX_REVIEW_ROUNDS - 1) in-loop review-round regenerations.
const CYCLES_PER_GENERATE = 1 + (MAX_REVIEW_ROUNDS - 1);
// In-session contract-repair headroom: each generateAndReview() may also fire up to ~2 repair
// re-prompts (one generator, one reviewer) that each tick the shared counter via onRepair.
const REPAIR_HEADROOM_PER_GENERATE = 2;

// Phase 6b: scope-dimensioned budget. When the planner yields multiple objectives, each objective
// is a legitimate unit of work (one agent session, one review). The base backstop covers a SINGLE
// objective's full loop sequence; multi-objective runs get an additive per-objective increment so the
// ceiling stays a TRUE backstop (never truncates legitimate work) while remaining meaningfully tighter
// than an unconstrained product. Each extra objective adds CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE
// cycles (one session's max cost) — conservative and proportional without being multiplicative.
// numObjectives defaults to 1 (single-agent path): the backstop reduces to the original derivation.
export function deriveCycleBackstop(maxRetries: number, numObjectives = 1): number {
  const generateEntries = 1 + MAX_STATIC_FIX_ROUNDS + maxRetries + 1;
  const singleObjectiveBase = generateEntries * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
  // Additional objectives each add one session's worth of budget (not the full loop sequence, since
  // worker sessions are bounded and do not go through the 4-loop generate→review→fix→coverage path).
  const extraObjectives = Math.max(0, numObjectives - 1);
  return singleObjectiveBase + extraObjectives * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
}

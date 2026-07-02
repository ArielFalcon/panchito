// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.ts
// Bridge: LearningPort -> cross-run-learning's REAL LearningRepositoryPort. THIN — no new policy.
// Off-path by contract: fold() delegates to applyOutcome but SWALLOWS any failure (logged, never
// re-thrown) — a learning-store fault must NEVER propagate to the caller and gate publish.
// retrieve() delegates to topRules(app, sha, limit) and projects the full structured rules as the
// RetrievedRule[] the barrel's LearningPort.retrieve() shape expects (W3 F1, dual-judge round: the
// bare-trigger string[] projection previously here starved both prompt renderers of action/
// errorClass/status/confidence). The v1 default (StubLearningRepository) makes this provably a
// no-op — retrieve() genuinely returns [] until a real store is wired.
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningPort, RetrievedRule } from "../../application/ports/index.ts";
import type { LearningRepositoryPort, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";

// Bounded so a single run's retrieval never fans out unbounded rule history — mirrors the legacy's
// own listLearningRules(app, limit) call sites, all of which pass a small fixed limit (20-200).
const DEFAULT_RETRIEVE_LIMIT = 20;

// RetrievedRule.status is narrowed to "active" | "candidate" (the only two statuses
// RuleGovernanceService.topRules ever returns — deprecated/superseded are filtered out before this
// point). A defensive fallback to "candidate" for any other value keeps this a total function
// without widening the port's own narrow union.
function toRetrievedStatus(status: RuleStatus): "active" | "candidate" {
  return status === "active" ? "active" : "candidate";
}

export class LearningPortAdapter implements LearningPort {
  constructor(
    private readonly repo: LearningRepositoryPort,
    private readonly app: string,
    private readonly limit = DEFAULT_RETRIEVE_LIMIT,
    // Injectable so a test can assert the swallow without polluting stderr; defaults to console.error.
    private readonly onFoldError: (err: unknown) => void = (err) => console.error("[LearningPortAdapter] fold failed (off-path, swallowed):", err),
  ) {}

  async fold(outcome: RunOutcome): Promise<void> {
    try {
      await this.repo.applyOutcome(outcome);
    } catch (err) {
      // Off-path by contract: never gates publish. Logged, not re-thrown.
      this.onFoldError(err);
    }
  }

  async retrieve(sha: Sha): Promise<RetrievedRule[]> {
    const rules = await this.repo.topRules(this.app, sha, this.limit);
    // W3 fix (F3a, dual-judge round): mirrors legacy's retrieveRules() — increment usage on
    // EXACTLY the set retrieved here (no separate budget-fit step exists at this port boundary
    // yet, so the retrieved set IS the "what the generator will see" set). Off-path: never
    // gates the run — a store without incrementUsage wired is a silent no-op (see the port's
    // own optional-method doc).
    if (rules.length > 0) {
      await this.repo.incrementUsage?.(rules.map((r) => r.id));
    }
    return rules.map((r) => ({
      trigger: r.trigger,
      action: r.action,
      errorClass: r.errorClass,
      status: toRetrievedStatus(r.status),
      confidence: r.confidence,
    }));
  }
}

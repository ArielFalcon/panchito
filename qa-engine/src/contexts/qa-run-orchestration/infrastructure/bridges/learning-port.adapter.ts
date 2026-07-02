// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.ts
// Bridge: LearningPort -> cross-run-learning's REAL LearningRepositoryPort. THIN — no new policy.
// Off-path by contract: fold() delegates to applyOutcome but SWALLOWS any failure (logged, never
// re-thrown) — a learning-store fault must NEVER propagate to the caller and gate publish.
// retrieve() delegates to topRules(app, sha, limit) and projects rule triggers as the string[] the
// barrel's LearningPort.retrieve() shape expects. The v1 default (StubLearningRepository) makes this
// provably a no-op — retrieve() genuinely returns [] until a real store is wired.
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningPort } from "../../application/ports/index.ts";
import type { LearningRepositoryPort } from "@contexts/cross-run-learning/application/ports/index.ts";

// Bounded so a single run's retrieval never fans out unbounded rule history — mirrors the legacy's
// own listLearningRules(app, limit) call sites, all of which pass a small fixed limit (20-200).
const DEFAULT_RETRIEVE_LIMIT = 20;

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

  async retrieve(sha: Sha): Promise<string[]> {
    const rules = await this.repo.topRules(this.app, sha, this.limit);
    return rules.map((r) => r.trigger);
  }
}

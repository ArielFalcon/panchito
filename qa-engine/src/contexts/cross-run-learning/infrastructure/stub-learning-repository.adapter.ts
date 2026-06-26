// src/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts
// The v1 wiring: learning is OFF-PATH. This no-op never returns rules (so generation is never
// influenced) and swallows saves/outcomes — provably never gates publish. Swap for
// SqliteLearningRepository post-cutover (SPEC OQ3: ship stubbed, fill adapters later).
import type { LearningRepositoryPort, LearningRule } from "../application/ports/index.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export class StubLearningRepository implements LearningRepositoryPort {
  async save(_rule: LearningRule): Promise<void> { /* off-path no-op */ }
  async topRules(_sha: Sha, _limit: number): Promise<LearningRule[]> { return []; }
  async applyOutcome(_outcome: RunOutcome): Promise<void> { /* off-path no-op */ }
}

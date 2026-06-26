// src/contexts/cross-run-learning/domain/rule-governance.service.ts
// The SINGLE source of ranking truth. The legacy ranking was DUPLICATED: once in applyOutcome's
// promotion logic and once in the SQL ORDER BY in history.ts. The SqliteLearningRepository now
// does a plain unordered SELECT and defers to THIS service — deleting the duplicate ORDER BY.
// Pure, off-path, never gates publish.
import type { LearningRule } from "../application/ports/index.ts";

const RETRIEVABLE: ReadonlySet<LearningRule["status"]> = new Set(["active", "candidate"]);

export class RuleGovernanceService {
  // Carries the former SQL ORDER BY verbatim:
  //   (status='active') DESC, COALESCE(success_rate, 0) DESC, at DESC
  // Three-key sort: status (active wins), then successRate (higher first, null→0),
  // then at (newer timestamp wins) — matches history.ts listRulesStmt exactly.
  rank(rules: readonly LearningRule[]): LearningRule[] {
    return [...rules].sort((a, b) => {
      const activeDelta = Number(b.status === "active") - Number(a.status === "active");
      if (activeDelta !== 0) return activeDelta;
      const rateDelta = (b.successRate ?? 0) - (a.successRate ?? 0);
      if (rateDelta !== 0) return rateDelta;
      return b.at.localeCompare(a.at); // at DESC: newer ISO string > older ISO string
    });
  }

  // Retrieval gate: only active+candidate rules are eligible (matches history.ts listRulesStmt's
  // `status IN ('active', 'candidate')`), then ranked and capped.
  topRules(rules: readonly LearningRule[], limit: number): LearningRule[] {
    return this.rank(rules.filter((r) => RETRIEVABLE.has(r.status))).slice(0, limit);
  }
}

// qa-engine/src/contexts/cross-run-learning/application/ports/index.ts
// Off-path flywheel ports (stubbed in v1; never gates publish). LearningRepositoryPort [SWAP] inverts
// the two-way SQLite coupling (history.ts imports applyOutcome; distiller/retrieval import history)
// into one port, making RuleGovernance the single source of ranking truth.
// ErrorClass stays in THIS context (no kernel leak) — modeled as a local string-literal union.
// ReflectorPort and ProcessAuditPort are re-added co-located with their impls in Plan 6.

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export type ErrorClass = string; // the real owner; the kernel RunOutcome.errorClass widens to this.
export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
// Extended to the full legacy LearningRule shape (src/qa/learning/learning-rule.ts).
// The Plan-2 stub had only 6 fields; rowToRule and the ranking service both need the
// remaining 7 (id, archetype, usageCount, outcomeCount, lastVerified, source, at).
export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  archetype?: string | null; // optional to align with legacy src/qa/learning/learning-rule.ts (archetype?: string | null)
  status: RuleStatus;
  confidence: "low" | "medium" | "high";
  usageCount: number;
  outcomeCount: number;
  successRate: number | null;
  lastVerified: string | null;
  source: string;
  at: string;              // ISO-8601 timestamp — the 3rd SQL sort key (at DESC tiebreak)
}
// [SWAP] inverts the SQLite coupling; ranking truth lives in RuleGovernance, not in SQL ORDER BY.
// `app` on topRules is a TYPED CONTRACT ONLY in v1: the legacy listLearningRules(app, limit) filters
// by app before returning any row — app-scoping is structural to multi-app correctness (mixing rules
// across apps corrupts retrieval). v1 impls accept it but do NOT yet filter (the stub returns []; the
// SQLite store passes it to the injected selectRules, whose filtering lands in Plan 6). Carrying it on
// the signature now makes the Plan-6 wiring closure physically unable to compile without supplying the
// app — converting a silent cross-app-contamination landmine into a compiler error.
// W3 fix (F3c, dual-judge round): the portable half of legacy's selectForRetrieval relevance bias
// (errorClass/archetype matching) — see RuleGovernanceService's own RelevanceBias header for the
// full rationale and the documented "not yet threaded from a real caller" gap. Optional field on
// topRules' own opts bag, not a positional param, so every existing call site (which omits it)
// keeps compiling unchanged.
export interface RelevanceBias {
  errorClass?: string | null;
  archetypes?: readonly string[];
}
export interface LearningRepositoryPort {
  save(rule: LearningRule): Promise<void>;
  topRules(app: string, sha: Sha, limit: number, relevance?: RelevanceBias): Promise<LearningRule[]>;
  applyOutcome(outcome: RunOutcome): Promise<void>;
  // W3 fix (F3a, dual-judge round): legacy increments usage_count per RETRIEVED rule
  // (src/qa/learning/retrieval.ts's `incrementRuleUsage(included.map((r) => r.id))`, called on the
  // budget-fitted retrieval set) — topRules() had no equivalent call anywhere in the port, so
  // usageCount never advanced past 0 for any rule retrieved through this port, no matter how many
  // times it was actually injected into a prompt. Optional (not folded into topRules itself) so a
  // caller/test that never retrieves need not stub it; the LearningPort bridge (learning-
  // port.adapter.ts) is the one production call site, invoked with the SAME ids topRules just
  // returned, immediately after retrieval — matching legacy's own "record usage on exactly what the
  // generator will see" ordering.
  incrementUsage?(ids: readonly string[]): Promise<void>;
}
// Aligned to legacy src/types.ts StructuredReflection (8 fields). Field pruning, if any, is decided
// when porting the learning context (Plan 6), not here — do not silently truncate.
export interface StructuredReflection {
  goal: string;
  decision: string;
  assumption: string;
  errorClass: ErrorClass;   // uses the local ErrorClass alias (string)
  gateSignal: string;
  evidence: string;
  rootCause: string;
  preventiveRule: { trigger: string; action: string };
}

// src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts
// LearningRepositoryPort over SQLite — inverts the legacy two-way coupling (history.ts imported
// applyOutcome; distiller/retrieval imported history). The store is injected (no SQLite binary in
// tests); ranking is delegated to RuleGovernanceService (the SELECT is UNORDERED — the duplicate
// SQL ORDER BY is gone). Off-path: a failure here never gates publish.
//
// §11 BASE-FIX: legacy rows may carry status 'pending' (retired in the port's RuleStatus). The read
// path coerces 'pending' → 'candidate' BEFORE typing so no row violates the port type and no rule
// is silently dropped.
import type { LearningRepositoryPort, LearningRule, RuleStatus, ErrorClass } from "../application/ports/index.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RuleGovernanceService } from "../domain/rule-governance.service.ts";

// Column names mirror the real `learning_rules` schema (history.ts). The DB uses trigger_text and
// action_text (NOT trigger/action). All fields rowToRule reads are declared here so the adapter
// test can supply a full-fidelity fake row without hitting SQLite.
export interface LearningRow {
  id: string;
  trigger_text: string;
  action_text: string;
  error_class: string;
  archetype: string | null;
  status: string;
  confidence: string;
  usage_count: number;
  outcome_count: number;
  success_rate: number | null;
  last_verified: string | null;
  source: string;
  at: string;
}
export interface LearningStore {
  // §11 doc: selectRules MUST run the production-query path: `status IN ('active', 'candidate')`.
  // The 'pending'→'candidate' coercion in rowToRule is back-compat defense for rows inserted by
  // an older build on an unfiltered read path (e.g. listAllLearningRules). On the filtered path it
  // is dead-but-harmless; it is kept because the adapter cannot guarantee what the injected store
  // returns in tests.
  // CRL-02: `app` is a TYPED CONTRACT ONLY in v1. The legacy listLearningRules(app, limit) filters by
  // app before returning any row — without per-app scoping the first real wiring would return every
  // app's rules to every run (corrupt cross-app retrieval). The adapter threads `app` into the store
  // call so the Plan-6 wiring closure (`{ selectRules: (app) => listLearningRules(app, 200) }`) cannot
  // compile without it; the in-test fakes accept it and ignore it. The actual filtering is Plan 6.
  selectRules(app: string): LearningRow[];      // UNORDERED — ranking is the service's job
  upsert(rule: LearningRule): void;
  recordOutcome(outcome: RunOutcome): void;
}

// §11: 'pending' (retired) maps to 'candidate'. Any unknown status also falls back to 'candidate'
// (safe default — retrievable but unpromoted) rather than throwing on a malformed legacy row.
function coerceStatus(raw: string): RuleStatus {
  if (raw === "active" || raw === "deprecated" || raw === "superseded") return raw;
  return "candidate"; // 'pending' and anything unexpected → candidate
}

// Maps a real DB row (trigger_text/action_text columns) to the full LearningRule port type.
// Mirrors history.ts rowToRule exactly so no field is silently dropped.
function rowToRule(row: LearningRow): LearningRule {
  return {
    id: row.id,
    trigger: row.trigger_text,
    action: row.action_text,
    errorClass: row.error_class as ErrorClass,
    archetype: row.archetype ?? null,
    status: coerceStatus(row.status),
    confidence: row.confidence === "low" ? "low" : row.confidence === "high" ? "high" : "medium",
    usageCount: row.usage_count,
    outcomeCount: row.outcome_count ?? 0,
    successRate: row.success_rate,
    lastVerified: row.last_verified,
    source: row.source,
    at: row.at,
  };
}

export class SqliteLearningRepository implements LearningRepositoryPort {
  private readonly governance = new RuleGovernanceService();
  constructor(private readonly store: LearningStore) {}

  async save(rule: LearningRule): Promise<void> {
    this.store.upsert(rule);
  }

  async topRules(app: string, _sha: Sha, limit: number): Promise<LearningRule[]> {
    // CRL-02: `app` is threaded into the store seam so the Plan-6 wiring closure must supply it.
    // v1 stores ignore the argument (no per-app filtering yet); the typed obligation is the point.
    const rules = this.store.selectRules(app).map(rowToRule);
    return this.governance.topRules(rules, limit);
  }

  async applyOutcome(outcome: RunOutcome): Promise<void> {
    // Off-path governance fold. The promotion math lives in the injected store's recordOutcome
    // (which wraps the legacy applyOutcome at wiring time) — never imported from history.ts here.
    this.store.recordOutcome(outcome);
  }
}

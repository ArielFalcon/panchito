// qa-engine/src/contexts/cross-run-learning/application/ports/index.ts
// Off-path flywheel ports (stubbed in v1; never gates publish). LearningRepositoryPort [SWAP] inverts
// the two-way SQLite coupling (history.ts imports applyOutcome; distiller/retrieval import history)
// into one port, making RuleGovernance the single source of ranking truth.
// ErrorClass stays in THIS context (no kernel leak) — modeled as a local string-literal union.
// ReflectorPort is declared here (ADR-5, reflector-rewire design): its collaborators
// (StructuredReflection, distiller, LearningRepositoryPort) all live in this context, so the port is
// co-located with them rather than in qa-run-orchestration. ProcessAuditPort is declared here too
// (sdd/migration-remediation Slice 5, D-P1b) — this IS the "later plan" this comment used to defer
// to; see ProcessAuditPort's own header below for the full contract.

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
// [judgment-day FIX 4] RelevanceBias's canonical declaration lives in the domain
// (rule-governance.service.ts) — domain owns it; this layer imports + re-exports, mirroring the
// RetrievedRule precedent one layer up (qa-run-orchestration's own application/ports re-exports its
// domain-owned shapes rather than redeclaring them). Previously declared identically in BOTH files
// with no import relationship — a silent duplicate that could drift undetected.
import type { RelevanceBias } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
export type { RelevanceBias };

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
  // WS1.4(b): count of outcomes folded via the ORACLE-scored path (valueScore !== null), never the
  // prevention path. Mirrors legacy src/qa/learning/learning-rule.ts's LearningRule.oracleOutcomeCount
  // exactly — the objective-evidence anchor nextStatus's candidate -> active gate requires >= 1 of.
  oracleOutcomeCount: number;
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
// keeps compiling unchanged. (RelevanceBias itself is imported + re-exported above — domain owns it.)
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
  // WS1.3 (full-flow remediation): minimal read for the anti-respawn dedup guard
  // (cross-run-learning/domain/distill-rule.ts's decideDistill). topRules() is RETRIEVAL-scoped —
  // it filters to active/candidate only (RuleGovernanceService's RETRIEVABLE set) — so it cannot
  // see a deprecated/superseded row and would let a demoted pattern respawn as a fresh candidate.
  // Mirrors legacy's listAllLearningRules(app, limit) (src/server/history.ts), which exists for
  // EXACTLY this reason: "ALL rules regardless of status — used ONLY by the distiller for
  // de-duplication". Optional (same optionality convention as incrementUsage above) so a
  // caller/fake/store that never distills need not implement it.
  //
  // LIVE as of Task 2 (full-flow remediation): the production bridge
  // (src/server/rewritten-engine-factory.ts's historyLearningStore) now wires this onto
  // history.ts's listAllLearningRules via SqliteLearningRepository.listAll — ReflectorPortAdapter's
  // anti-respawn dedup actually sees the full existing-rule set in production. A store/fake that
  // still omits selectAllRules remains a fail-open no-op (empty existing set), never a stricter
  // gate than before this method existed — that fallback is preserved for tests only now.
  listAll?(app: string, limit: number): Promise<LearningRule[]>;
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

// ADR-4 (reflector-rewire design): a NARROW projection of RunOutcome, not the wide kernel type.
// RunOutcome.logs?/note? are STRUCTURALLY unreachable here — they are simply not fields on this
// type — so a reflection prompt can never leak raw execution logs or diagnostic notes even if
// buildReflectionPrompt were later widened. The use-case constructs this projection at the fold
// call site (toReflectionInput); the adapter never reads RunOutcome directly.
export interface ReflectionInput {
  runId: string;
  app: string;
  sha: string;
  mode: string;
  verdict: string;
  errorClass: ErrorClass;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    flaky: boolean;
    retries: number;
  };
  // WS1.5 (full-flow remediation): the run's diff-derived structural shape (form/api-call/
  // stateful-cache/auth-flow/data-list/generic — cross-run-learning/domain/distill-rule.ts's
  // detectArchetype), computed by the use-case from the SAME classificationDiff every other
  // diff-mode enrichment already reuses. NOT the raw diff itself — ADR-4's narrow-projection
  // contract (this interface's own header) is preserved: only the already-derived tag crosses the
  // port boundary, never raw diff text. Absent/null outside diff mode (no diff to analyze) or when
  // detection found no recognizable shape falls back to "generic" — see detectArchetype's own
  // "never fabricates" contract for the true absent case (undefined diff -> null).
  archetype?: string | null;
}

// ADR-1 (reflector-rewire design): the reflect gate is STRICTER than the fold gate at the call
// site (shouldDistillLearning(...) AND verdict!=="flaky" AND errorClass not in E-INFRA/E-FLAKY) —
// this port itself carries no gating logic, it only accepts whatever narrow input the use-case
// decided to send. reflect() is fire-isolated by the adapter (ADR-2/fault isolation): a crash,
// timeout, or malformed-JSON response must never throw past this method — see
// ReflectorPortAdapter's own header for the full fault-isolation contract.
export interface ReflectorPort {
  reflect(input: ReflectionInput): Promise<void>;
}

// ProcessAuditPort (sdd/migration-remediation Slice 5, D-P1b): the deterministic post-run PROCESS
// audit — the engine reflecting on its OWN run quality (recurring defects, ledger noise, review
// churn), routing each finding to the right remediation. Co-located with ReflectorPort per this
// file's own header note: both are off-path, best-effort, fault-isolated collaborators the use-case
// invokes AFTER learning.fold() at each fold site. Unlike ReflectorPort, this port takes the FULL
// (wide) kernel RunOutcome directly — no narrow ReflectionInput-style projection — because the
// domain logic (cross-run-learning/domain/process-audit.ts) reasons over gateSignals.retries/
// reviewerApproved/errorClass/verdict/sha, all of which already live on RunOutcome undisguised.
// [SWAP]-optional collaborator on RunQaUseCaseDeps (qa-run-orchestration/application/run-qa.use-case.ts)
// — absent means the audit never runs, the SAME "provable no-op" backward-compat posture
// ReflectorPort/ConfinementPort already establish. The adapter (../infrastructure/
// process-audit-port.adapter.ts) self-sources `recent` outcomes + `rules` via factory-injected reads
// and dispatches findings to 3 sinks also injected from src via the factory — this context and this
// port never import src/ directly. Fault-isolated + timeout-capped inside the adapter (mirrors
// ReflectorPortAdapter's own documented fault-isolation contract) — a crash, a slow injected
// read/sink, or a malformed finding never propagates past audit(); the use-case awaits with no extra
// try/catch of its own, trusting the adapter's contract exactly like it trusts ReflectorPort's.
export interface ProcessAuditPort {
  audit(outcome: RunOutcome): Promise<void>;
}

// qa-engine/src/contexts/cross-run-learning/application/ports/index.ts
// Off-path flywheel ports (stubbed in v1; never gates publish). LearningRepositoryPort [SWAP] inverts
// the two-way SQLite coupling (history.ts imports applyOutcome; distiller/retrieval import history)
// into one port, making RuleGovernance the single source of ranking truth. ReflectorPort uses
// AgentRuntimePort (consumed from the kernel via generation/agent-runtime, not redefined here).
// ErrorClass stays in THIS context (no kernel leak) — modeled as a local string-literal union.

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export type ErrorClass = string; // the real owner; the kernel RunOutcome.errorClass widens to this.
export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
export interface LearningRule {
  trigger: string; action: string; errorClass: ErrorClass; status: RuleStatus;
  confidence: "low" | "medium" | "high"; successRate: number | null;
}
// [SWAP] inverts the SQLite coupling; ranking truth lives in RuleGovernance, not in SQL ORDER BY.
export interface LearningRepositoryPort {
  save(rule: LearningRule): Promise<void>;
  topRules(sha: Sha, limit: number): Promise<LearningRule[]>;
  applyOutcome(outcome: RunOutcome): Promise<void>;
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
export interface ReflectorPort {
  reflect(outcome: RunOutcome): Promise<StructuredReflection | null>;
}
export interface ProcessFinding { kind: string; detail: string; }
export interface ProcessAuditPort {
  audit(outcome: RunOutcome): Promise<ProcessFinding[]>;
}

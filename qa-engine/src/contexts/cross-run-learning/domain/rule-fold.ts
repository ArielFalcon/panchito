// qa-engine/src/contexts/cross-run-learning/domain/rule-fold.ts
// P4a: verbatim port of the pure governance math from (historical) src/qa/learning/learning-rule.ts —
// applyOutcome, deriveConfidence, nextStatus, preventionOutcome, attributableRules, and the governance
// constants. Ported, not reimplemented: parity is enforced by
// qa-engine/test/contexts/cross-run-learning/domain/rule-fold-parity.test.ts against the live legacy
// module (excluded from qa-engine's own tsconfig.json, typechecked only under tsconfig.parity.json —
// same pattern as adjudicate-parity.test.ts and the other *-parity tests).
//
// This module operates on the port's OWN LearningRule shape (cross-run-learning/application/ports)
// rather than importing legacy's type — errorClass here is the port's wide `string` alias, matching
// every other kernel/port boundary in this migration.

import type { LearningRule, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";

// ── Governance: confidence earned from outcomes, asymmetric hysteresis ───────────
// A rule must EARN promotion over several measured outcomes and is slow to be demoted,
// so a single anomalous outcome (a flaky run, an unknown external event) cannot flip a
// trusted rule. Nothing is ever deleted — a demoted rule is "deprecated" and can be
// resurrected if later outcomes recover.
export const MIN_OUTCOMES = 3; // measured outcomes required before any status change
export const PROMOTE_RATE = 0.6; // running-mean successRate to promote candidate/deprecated → active
export const DEMOTE_RATE = 0.3; // running-mean successRate to demote active → deprecated

export function deriveConfidence(outcomeCount: number, successRate: number | null): "low" | "medium" | "high" {
  if (outcomeCount < MIN_OUTCOMES || successRate === null) return "low";
  if (successRate >= 0.7) return "high";
  if (successRate >= 0.45) return "medium";
  return "low";
}

// coverageCreditConfirmed is the coverage-anchor governance signal.
//   true  → coverage was measured AND confirmed credit (covered lines in the changed diff) — promotion eligible
//   false → coverage was measured but NO credit (covered 0 changed lines) — promotion blocked for this transition
//   null  → coverage not measured / cross-repo / unknown — no gate (promotion proceeds normally)
// This is the non-circular anchor: a rule can only earn `active` when the test that exercised it
// also covered the diff's changed lines, not just made the reviewer happy. Coverage stays
// non-blocking where unmeasurable (null), so the flywheel turns for every app.
//
// WS1.4(b): oracleOutcomeCount is the SECOND non-circular anchor, alongside coverage. Promotion is
// objective-signal-only per the project invariant — prevention credit is DERIVED (absence of a
// failure class), not an objective observation, so three clean prevention-only runs must NEVER by
// themselves promote a candidate to `active`. Verbatim-ported twin of legacy's identical gate.
function nextStatus(
  status: RuleStatus,
  outcomeCount: number,
  successRate: number,
  coverageCreditConfirmed: boolean | null = null,
  oracleOutcomeCount = 0,
): RuleStatus {
  // "pending" is a RETIRED legacy status (excluded from retrieval, no live producer). The port's
  // RuleStatus type does not include it, so this branch is unreachable through the port surface —
  // kept only to preserve verbatim parity with legacy's nextStatus, which still has it.
  if ((status as string) === "pending") return "candidate";
  if (outcomeCount < MIN_OUTCOMES) return status; // not enough evidence to move
  switch (status) {
    case "candidate": {
      if (successRate < PROMOTE_RATE) return "candidate";
      // When coverage IS measured (non-null), require confirmed credit for promotion. When coverage
      // is unmeasurable (null), allow promotion on verdict signal alone so the flywheel turns for
      // every app, not just those with source-mapped DEV environments.
      if (coverageCreditConfirmed === false) return "candidate"; // measured, no credit — hold
      // WS1.4(b) oracle-evidence anchor: promotion requires AT LEAST ONE oracle-scored outcome.
      // Prevention-only evidence may raise successRate/confidence but never flips status alone.
      if (oracleOutcomeCount < 1) return "candidate"; // zero objective evidence — hold
      return "active";
    }
    case "active":
      return successRate < DEMOTE_RATE ? "deprecated" : "active";
    case "deprecated":
      return successRate >= PROMOTE_RATE ? "active" : "deprecated"; // reversible
    default:
      return status; // superseded is terminal (handled by the distiller, not by outcomes)
  }
}

// ── Governance WITHOUT an oracle: the prevention signal ──────────────────────────
// The oracle (mutation / fault-injection) is the strong ground-truth, but it is opt-in and
// not applicable to every app. To make the flywheel turn for ANY app, we derive a weaker,
// CONSERVATIVE signal from the run's own errorClass — available on every run, no oracle needed:
//
//   - The rule's OWN class still occurred (the run was labeled with it) → 0. Strong, precise
//     negative: the rule failed at the exact thing it exists to prevent.
//   - A CLEAN run (no errorClass) → a weak positive. The rule "held". Capped at the medium band
//     (see PREVENTION_HELD_SCORE) so a proxy-only rule can reach "active/medium" but NEVER "high".
//   - An UNRELATED failure (some other class), or a noisy class (infra/flaky) → null: no evidence
//     either way, so the rule's statistics are left untouched.
export const PREVENTION_HELD_SCORE = 0.6;

// WS1.4(a) (full-flow remediation, INTERIM promotion-safety gate): a rule whose OWN errorClass is
// empty/blank is unfalsifiable — a real run's errorClass is either a genuine, non-blank class or
// null (the taxonomy never produces ""), so `runErrorClass === ruleErrorClass` can NEVER be true for
// a blank ruleErrorClass. Such a rule could therefore only ever hit the clean-run branch below
// (PREVENTION_HELD_SCORE) and could never be scored 0 — a free ride to promotion with zero
// falsifiable evidence. Guard first, before any class comparison, so a blank rule earns no
// prevention signal at all (the caller already treats null as "no write" — see
// rewritten-engine-factory.ts's `if (score !== null) recordRuleOutcome(...)`). Verbatim-ported twin
// of legacy's identical guard — kept in lockstep by rule-fold-parity.test.ts.
export function preventionOutcome(ruleErrorClass: string, runErrorClass: string | null): number | null {
  if (ruleErrorClass.trim() === "") return null; // unfalsifiable rule — no credit, no debit
  if (runErrorClass === "E-INFRA" || runErrorClass === "E-FLAKY") return null; // noisy — teaches nothing
  if (runErrorClass === ruleErrorClass) return 0; // the rule did not prevent its own class
  if (runErrorClass === null) return PREVENTION_HELD_SCORE; // clean run → the rule held (weak positive)
  return null; // an unrelated failure → no evidence about this rule
}

// Fold one objective outcome (a valueScore in [0,1]) into a rule. successRate is a RUNNING
// MEAN over all outcomes — never an overwrite — so confidence is earned from many results.
// Pure: no time, no I/O (the caller stamps lastVerified).
//
// WS1.4(b): isOracleScore tells applyOutcome whether THIS outcome came from the oracle path (a
// real valueScore) or the prevention path (preventionOutcome's derived signal). Defaults to
// false — verbatim-ported twin of legacy's identical parameter; see legacy's own header for the
// full rationale.
export function applyOutcome(
  rule: LearningRule,
  score: number,
  coverageCreditConfirmed: boolean | null = null,
  isOracleScore = false,
): LearningRule {
  const n = (rule.outcomeCount ?? 0) + 1;
  const oracleOutcomeCount = (rule.oracleOutcomeCount ?? 0) + (isOracleScore ? 1 : 0);
  const prev = rule.successRate;
  const successRate = prev === null || prev === undefined ? score : prev + (score - prev) / n;
  return {
    ...rule,
    outcomeCount: n,
    oracleOutcomeCount,
    successRate,
    confidence: deriveConfidence(n, successRate),
    status: nextStatus(rule.status, n, successRate, coverageCreditConfirmed, oracleOutcomeCount),
  };
}

// Context-directed attribution: fold an oracle outcome only onto rules that COULD have influenced it,
// so a global suite-quality score is not smeared across genuinely-irrelevant rules. Fail-open on two
// levels: (1) with no known diff archetypes, keep every rule; (2) PER RULE, an untagged rule (no
// archetype) carries no signal to discriminate on, so it is kept — only a rule whose archetype is
// PRESENT and does NOT match the diff is dropped as noise. Pure and deterministic.
export function attributableRules(rules: LearningRule[], ctx: { diffArchetypes: string[] }): LearningRule[] {
  if (ctx.diffArchetypes.length === 0) return rules;
  const shapes = new Set(ctx.diffArchetypes);
  return rules.filter((r) => r.archetype == null || shapes.has(r.archetype));
}

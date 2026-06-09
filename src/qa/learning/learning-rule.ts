import type { ErrorClass } from "./taxonomy";

export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
export type Confidence = "low" | "medium" | "high";

export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  confidence: Confidence;
  usageCount: number; // times this rule was retrieved into a prompt
  outcomeCount: number; // times an objective outcome (valueScore) was folded in
  successRate: number | null; // running mean of outcomes in [0,1] (null until first outcome)
  lastVerified: string | null;
  source: string;
  status: RuleStatus;
  at: string;
}

export interface RuleUpsert {
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  source: string;
}

// ── Governance: confidence earned from outcomes, asymmetric hysteresis ───────────
// A rule must EARN promotion over several measured outcomes and is slow to be demoted,
// so a single anomalous outcome (a flaky run, an unknown external event) cannot flip a
// trusted rule. Nothing is ever deleted — a demoted rule is "deprecated" and can be
// resurrected if later outcomes recover.
const MIN_OUTCOMES = 3; // measured outcomes required before any status change
const PROMOTE_RATE = 0.6; // running-mean successRate to promote candidate/deprecated → active
const DEMOTE_RATE = 0.3; // running-mean successRate to demote active → deprecated

export function deriveConfidence(outcomeCount: number, successRate: number | null): Confidence {
  if (outcomeCount < MIN_OUTCOMES || successRate === null) return "low";
  if (successRate >= 0.7) return "high";
  if (successRate >= 0.45) return "medium";
  return "low";
}

function nextStatus(status: RuleStatus, outcomeCount: number, successRate: number): RuleStatus {
  if (outcomeCount < MIN_OUTCOMES) return status; // not enough evidence to move
  switch (status) {
    case "candidate":
      return successRate >= PROMOTE_RATE ? "active" : "candidate";
    case "active":
      return successRate < DEMOTE_RATE ? "deprecated" : "active";
    case "deprecated":
      return successRate >= PROMOTE_RATE ? "active" : "deprecated"; // reversible
    default:
      return status; // superseded is terminal (handled by the distiller, not by outcomes)
  }
}

// Fold one objective outcome (a valueScore in [0,1]) into a rule. successRate is a RUNNING
// MEAN over all outcomes — never an overwrite — so confidence is earned from many results.
// Pure: no time, no I/O (the caller stamps lastVerified).
export function applyOutcome(rule: LearningRule, score: number): LearningRule {
  const n = (rule.outcomeCount ?? 0) + 1;
  const prev = rule.successRate;
  const successRate = prev === null || prev === undefined ? score : prev + (score - prev) / n;
  return {
    ...rule,
    outcomeCount: n,
    successRate,
    confidence: deriveConfidence(n, successRate),
    status: nextStatus(rule.status, n, successRate),
  };
}

export function ruleKey(rule: { trigger: string; action: string }): string {
  return `${rule.trigger}::${rule.action}`;
}

export function deduplicateRules(
  candidates: RuleUpsert[],
  existing: LearningRule[],
): { toInsert: RuleUpsert[]; toSkip: string[] } {
  const existingKeys = new Set(existing.map(ruleKey));
  const toInsert: RuleUpsert[] = [];
  const toSkip: string[] = [];

  for (const c of candidates) {
    const key = ruleKey(c);
    if (existingKeys.has(key)) {
      toSkip.push(key);
    } else {
      existingKeys.add(key); // prevent duplicates within the batch
      toInsert.push(c);
    }
  }

  return { toInsert, toSkip };
}

export function selectForRetrieval(
  rules: LearningRule[],
  opts: {
    app: string;
    errorClass?: ErrorClass | null;
    maxRules?: number;
  },
): LearningRule[] {
  // Only proven (active) or still-exploring (candidate) rules are eligible; deprecated and
  // superseded rules are never injected. Ranking: ACTIVE rules first (exploit what has earned
  // its place), then by successRate (the attribution signal), then relevance to this run's
  // errorClass. Candidates fill the remaining slots as a bounded exploration tail so they can
  // accumulate the outcomes that earn — or deny — promotion.
  const eligible = rules.filter((r) => r.status === "active" || r.status === "candidate");

  const score = (r: LearningRule): number => {
    let s = 0;
    if (r.status === "active") s += 100; // exploit before explore
    s += (r.successRate ?? 0) * 10; // earned-from-outcomes signal
    if (opts.errorClass && r.errorClass === opts.errorClass) s += 3; // relevance
    return s;
  };

  const scored = eligible.map((r) => ({ rule: r, score: score(r) }));
  scored.sort((a, b) => b.score - a.score);

  const limit = opts.maxRules ?? 8;
  return scored.slice(0, limit).map((s) => s.rule);
}

export function renderRulesForPrompt(rules: LearningRule[]): string {
  if (rules.length === 0) return "";

  const lines = [
    "## Learned rules from past QA runs",
    "These rules were derived from real failures. Apply them when they match the current change.",
    "",
  ];

  for (const r of rules) {
    lines.push(`### Rule (${r.errorClass}, confidence=${r.confidence})`);
    lines.push(`- Trigger: ${r.trigger}`);
    lines.push(`- Action: ${r.action}`);
    lines.push("");
  }

  return lines.join("\n");
}

import type { ErrorClass } from "./taxonomy";

export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
export type Confidence = "low" | "medium" | "high";

export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  confidence: Confidence;
  usageCount: number;
  successRate: number | null;
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
  const active = rules.filter((r) => r.status === "active" || r.status === "candidate");

  const scored = active.map((r) => {
    let score = 0;
    if (r.errorClass === opts.errorClass) score += 3;
    if (r.confidence === "high") score += 2;
    else if (r.confidence === "medium") score += 1;
    score += r.usageCount * 0.5;
    return { rule: r, score };
  });

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

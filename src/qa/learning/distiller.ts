import type { StructuredReflection } from "../../types";
import type { RuleUpsert } from "./learning-rule";
import { deduplicateRules, ruleKey } from "./learning-rule";
import { errorClassFromCorrections } from "./taxonomy";
import { upsertLearningRule, listAllLearningRules } from "../../server/history";
import { randomBytes } from "node:crypto";

// Cap distilled rule fields so a runaway reviewer correction cannot blow up the DB row size
// or the prompt that later renders the rule.
const RULE_FIELD_MAX = 400;

export interface DistillerInput {
  app: string;
  runId: string;
  reflection: StructuredReflection;
}

export function reflectionToRuleUpsert(input: DistillerInput): RuleUpsert {
  return {
    trigger: input.reflection.preventiveRule.trigger.slice(0, RULE_FIELD_MAX),
    action: input.reflection.preventiveRule.action.slice(0, RULE_FIELD_MAX),
    errorClass: input.reflection.errorClass,
    source: input.runId,
  };
}

export function distillReflection(input: DistillerInput): { inserted: boolean; ruleId: string } {
  const candidate = reflectionToRuleUpsert(input);
  // Dedup against ALL statuses (incl. deprecated/superseded): a recurring failure pattern must not
  // spawn a duplicate candidate for a rule that was already tried and demoted.
  const existing = listAllLearningRules(input.app, 200);
  const { toInsert, toSkip } = deduplicateRules([candidate], existing);

  if (toInsert.length === 0) {
    const skippedKey = toSkip[0] ?? ruleKey(candidate);
    const match = existing.find((r) => ruleKey(r) === skippedKey);
    return { inserted: false, ruleId: match?.id ?? skippedKey };
  }

  const ruleId = `rule-${input.runId.slice(-8)}-${randomBytes(3).toString("hex")}`;
  upsertLearningRule({
    ...candidate,
    app: input.app,
    id: ruleId,
  });

  return { inserted: true, ruleId };
}

// A reviewer correction distilled into a candidate rule: the correction text IS the
// action (what to check before finishing), classified by the anti-pattern catalog.
export function correctionToRuleUpsert(input: { correction: string; runId: string }): RuleUpsert | null {
  const text = input.correction.trim().slice(0, RULE_FIELD_MAX);
  if (!text) return null;
  const errorClass = errorClassFromCorrections([text]) ?? "E-REVIEWER-REJECTED";
  return {
    trigger: `generating specs prone to ${errorClass}`,
    action: text,
    errorClass,
    source: input.runId,
  };
}

// Off-path distillation of a rejection: every correction becomes a candidate rule,
// deduped against ALL statuses (a pattern already tried and demoted must not respawn).
// Same governance as oracle-born rules: candidates must EARN promotion via outcomes.
export function distillReviewerCorrections(input: {
  app: string;
  runId: string;
  corrections: string[];
}): { inserted: string[] } {
  const candidates = input.corrections
    .map((c) => correctionToRuleUpsert({ correction: c, runId: input.runId }))
    .filter((c): c is RuleUpsert => c !== null);
  if (candidates.length === 0) return { inserted: [] };

  // Pre-dedupe locally so a correction repeated within ONE rejection only spawns one candidate.
  const unique = new Map(candidates.map((c) => [ruleKey(c), c]));
  const existing = listAllLearningRules(input.app, 200);
  const { toInsert } = deduplicateRules([...unique.values()], existing);

  const inserted: string[] = [];
  for (const c of toInsert) {
    const ruleId = `rule-${input.runId.slice(-8)}-${randomBytes(3).toString("hex")}`;
    upsertLearningRule({ ...c, app: input.app, id: ruleId });
    inserted.push(ruleId);
  }
  return { inserted };
}

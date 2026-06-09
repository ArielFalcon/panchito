import type { StructuredReflection } from "../../types";
import type { RuleUpsert } from "./learning-rule";
import { deduplicateRules, ruleKey } from "./learning-rule";
import { upsertLearningRule, listAllLearningRules } from "../../server/history";
import { randomBytes } from "node:crypto";

export interface DistillerInput {
  app: string;
  runId: string;
  reflection: StructuredReflection;
}

export function reflectionToRuleUpsert(input: DistillerInput): RuleUpsert {
  return {
    trigger: input.reflection.preventiveRule.trigger,
    action: input.reflection.preventiveRule.action,
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

import type { ErrorClass } from "./taxonomy";
import type { LearningRule } from "./learning-rule";
import { selectForRetrieval, renderRulesForPrompt } from "./learning-rule";
import { listLearningRules, incrementRuleUsage } from "../../server/history";

export interface RetrievalInput {
  app: string;
  errorClass?: ErrorClass | null;
  archetypes?: string[]; // the current diff's structural shapes — biases retrieval toward matching rules
  maxRules?: number;
}

export interface RetrievalResult {
  rules: LearningRule[];
  promptSection: string;
}

export function retrieveRules(input: RetrievalInput): RetrievalResult {
  const all = listLearningRules(input.app, 50);
  const selected = selectForRetrieval(all, {
    app: input.app,
    errorClass: input.errorClass ?? null,
    archetypes: input.archetypes,
    maxRules: input.maxRules,
  });

  if (selected.length > 0) {
    incrementRuleUsage(selected.map((r) => r.id));
  }

  return {
    rules: selected,
    promptSection: renderRulesForPrompt(selected),
  };
}

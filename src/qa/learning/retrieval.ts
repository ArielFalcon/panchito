import type { ErrorClass } from "./taxonomy";
import type { LearningRule } from "./learning-rule";
import { selectForRetrieval, fitRulesToBudget, DEFAULT_RULES_CHAR_BUDGET } from "./learning-rule";
import { listLearningRules, incrementRuleUsage } from "../../server/history";

export interface RetrievalInput {
  app: string;
  errorClass?: ErrorClass | null;
  archetypes?: string[]; // the current diff's structural shapes — biases retrieval toward matching rules
  maxRules?: number;
  maxChars?: number; // defaults to DEFAULT_RULES_CHAR_BUDGET; invisible at the PipelineDeps call-site
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

  // Budget-fit BEFORE recording usage so usageCount and the retrieved-IDs set reflect exactly
  // what the generator will see — no phantom "used" rules that were truncated out of the prompt.
  const { included, rendered } = fitRulesToBudget(selected, input.maxChars ?? DEFAULT_RULES_CHAR_BUDGET);

  if (included.length > 0) {
    incrementRuleUsage(included.map((r) => r.id));
  }

  return { rules: included, promptSection: rendered };
}

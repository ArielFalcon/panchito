import type { StructuredReflection } from "../../types";
import type { RuleUpsert } from "./learning-rule";
import { deduplicateRules, ruleKey } from "./learning-rule";
import { errorClassFromCorrections } from "./taxonomy";
import { upsertLearningRule, listAllLearningRules } from "../../server/history";
import { randomBytes } from "node:crypto";

// Cap distilled rule fields so a runaway reviewer correction cannot blow up the DB row size
// or the prompt that later renders the rule.
const RULE_FIELD_MAX = 400;

// ── Canonical trigger form: "Applies when …" ─────────────────────────────────────
// A rule's trigger governs recall (it is what gets matched against a future change), so its
// phrasing matters the way a Skill's description governs triggering. The Reflector is ASKED to
// write triggers as an "Applies when <condition>" sentence, but the LLM is non-deterministic —
// so the distiller ENFORCES the shape here. Normalization is best-effort and never drops a rule:
// a non-compliant trigger is canonicalized rather than rejected. The result is a single readable
// sentence, which is also what makes the rule legible in the human audit view.
const TRIGGER_PREFIX = "Applies when ";
const TRIGGER_PREFIX_RE = /^applies\s+when\b\s*/i;

// Decapitalize ONLY an ordinary Capitalized leading word (e.g. "The" → "the") so
// "Applies when the diff …" reads cleanly. Acronyms ("API") and code identifiers ("getByRole")
// are left untouched — lowercasing them would corrupt the meaning.
function decapitalizeLeadingWord(body: string): string {
  const space = body.indexOf(" ");
  const first = space === -1 ? body : body.slice(0, space);
  if (/^[A-Z][a-z]+$/.test(first)) {
    return body.charAt(0).toLowerCase() + body.slice(1);
  }
  return body;
}

// Canonicalize a free-form trigger to "Applies when <body>". Idempotent; trims and collapses
// whitespace; strips a pre-existing prefix (any casing) before re-applying the canonical one.
// Returns "" when there is no body to anchor (empty input, or a bare "Applies when").
export function normalizeTrigger(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const body = collapsed.replace(TRIGGER_PREFIX_RE, "").trim();
  if (body === "") return "";
  return TRIGGER_PREFIX + decapitalizeLeadingWord(body);
}

// A trigger is well-formed when it carries the canonical prefix AND a non-empty condition body.
// Used by the ledger's static gate / audit view to flag (not drop) malformed rules.
export function isWellFormedTrigger(trigger: string): boolean {
  return TRIGGER_PREFIX_RE.test(trigger) && trigger.replace(TRIGGER_PREFIX_RE, "").trim().length > 0;
}

export interface DistillerInput {
  app: string;
  runId: string;
  reflection: StructuredReflection;
  archetype?: string | null; // the failing run's structural shape, so the rule recalls on that shape
}

export function reflectionToRuleUpsert(input: DistillerInput): RuleUpsert {
  return {
    // Cap the body BEFORE the prefix is applied so the "Applies when " prefix never eats into the
    // allowed condition length (and never truncates mid-prefix). Final field stays within RULE_FIELD_MAX.
    trigger: normalizeTrigger(input.reflection.preventiveRule.trigger.slice(0, RULE_FIELD_MAX - TRIGGER_PREFIX.length)),
    action: input.reflection.preventiveRule.action.slice(0, RULE_FIELD_MAX),
    errorClass: input.reflection.errorClass,
    archetype: input.archetype ?? null,
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
export function correctionToRuleUpsert(input: { correction: string; runId: string; archetype?: string | null }): RuleUpsert | null {
  const text = input.correction.trim().slice(0, RULE_FIELD_MAX);
  if (!text) return null;
  const errorClass = errorClassFromCorrections([text]) ?? "E-REVIEWER-REJECTED";
  return {
    trigger: normalizeTrigger(`generating specs prone to ${errorClass}`),
    action: text,
    errorClass,
    archetype: input.archetype ?? null,
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
  archetype?: string | null;
}): { inserted: string[] } {
  const candidates = input.corrections
    .map((c) => correctionToRuleUpsert({ correction: c, runId: input.runId, archetype: input.archetype }))
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

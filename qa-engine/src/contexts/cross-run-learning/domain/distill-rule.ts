// qa-engine/src/contexts/cross-run-learning/domain/distill-rule.ts
// WS1.3 (full-flow remediation): verbatim port of the pure distillation logic from (legacy)
// src/qa/learning/distiller.ts + src/qa/learning/learning-rule.ts — trigger canonicalization,
// the ruleKey dedup key, the 400-char field caps, and the anti-respawn dedup DECISION (candidate
// vs. the full existing-rule set, incl. deprecated/superseded). Ported, not reimplemented: parity
// is enforced by qa-engine/test/contexts/cross-run-learning/domain/distill-rule-parity.test.ts
// against the live legacy modules (excluded from qa-engine's own tsconfig.json, typechecked only
// under tsconfig.parity.json — same pattern as rule-fold.ts / rule-fold-parity.test.ts).
//
// ReflectorPortAdapter (../infrastructure/reflector-port.adapter.ts) built LearningRule objects
// inline, bypassing legacy's distiller entirely. That bypass lost: exact-text ruleKey dedup, the
// anti-respawn guard (a demoted pattern must not respawn as a fresh candidate), normalizeTrigger
// canonicalization, and the field caps (unbounded LLM text flowing into SQLite rows and future
// prompts). This module restores those semantics on the port's OWN LearningRule shape
// (cross-run-learning/application/ports) — the same "operate on the port's shape, not legacy's
// type" convention rule-fold.ts documents in its own header.
//
// This module is PURE: no I/O, no time (the caller stamps `at`/generates the id). The "fetch
// existing rules" and "call repo.save" steps live in the adapter, which owns the off-path fault
// isolation; this module only decides.
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

// Cap distilled rule fields so a runaway reviewer correction cannot blow up the DB row size or the
// prompt that later renders the rule.
export const RULE_FIELD_MAX = 400;

// ── Canonical trigger form: "Applies when …" ─────────────────────────────────────
// A rule's trigger governs recall (it is what gets matched against a future change), so its
// phrasing matters the way a Skill's description governs triggering. The Reflector is ASKED to
// write triggers as an "Applies when <condition>" sentence, but the LLM is non-deterministic —
// so normalization ENFORCES the shape here. Normalization is best-effort and never drops a rule:
// a non-compliant trigger is canonicalized rather than rejected. The result is a single readable
// sentence, which is also what makes the rule legible in the human audit view.
export const TRIGGER_PREFIX = "Applies when ";
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
// Used by any static gate / audit view that wants to flag (not drop) malformed rules.
export function isWellFormedTrigger(trigger: string): boolean {
  return TRIGGER_PREFIX_RE.test(trigger) && trigger.replace(TRIGGER_PREFIX_RE, "").trim().length > 0;
}

// Cap a candidate's trigger/action to RULE_FIELD_MAX and normalize the trigger. The trigger body
// is capped BEFORE the "Applies when " prefix is applied so the prefix never eats into the allowed
// length (and normalization never truncates mid-prefix) — mirrors legacy's reflectionToRuleUpsert
// ordering exactly.
export function capRuleFields<T extends { trigger: string; action: string }>(candidate: T): T {
  return {
    ...candidate,
    trigger: normalizeTrigger(candidate.trigger.slice(0, RULE_FIELD_MAX - TRIGGER_PREFIX.length)),
    action: candidate.action.slice(0, RULE_FIELD_MAX),
  };
}

// Triggers/actions are free-form LLM text, so near-identical rules differ only by casing,
// surrounding whitespace, or trailing punctuation ("Fragile selector" vs "fragile selector.").
// Normalize before keying so those collapse to one rule instead of accumulating as distinct
// candidates — exact byte-equality would let the store grow unbounded with semantic duplicates.
function normalizeRuleText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "").trim();
}

export function ruleKey(rule: { trigger: string; action: string }): string {
  return `${normalizeRuleText(rule.trigger)}::${normalizeRuleText(rule.action)}`;
}

export type DistillDecision =
  | { decision: "save"; key: string }
  | { decision: "skip-duplicate"; key: string; match: LearningRule };

// The anti-respawn / dedup decision: given a candidate rule (already trigger/action-shaped) and
// the FULL set of existing rules for the app — including deprecated/superseded — decide whether
// to save it as new or skip it as a duplicate. Dedup MUST scan every status: a recurring failure
// pattern must not spawn a fresh candidate for a rule that was already tried and demoted. This is
// the core guarantee ReflectorPortAdapter's inline object-construction bypass lost.
export function decideDistill(
  candidate: { trigger: string; action: string },
  existingRules: readonly LearningRule[],
): DistillDecision {
  const key = ruleKey(candidate);
  const match = existingRules.find((r) => ruleKey(r) === key);
  if (match) return { decision: "skip-duplicate", key, match };
  return { decision: "save", key };
}

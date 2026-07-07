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

// ── WS1.5 (full-flow remediation): archetype detection ──────────────────────────────────────────
// LearningRule.archetype is the diff's STRUCTURAL SHAPE (form/api-call/stateful-cache/auth-flow/
// data-list/generic) — a DIFFERENT, independent taxonomy from errorClass (the failure-mode
// taxonomy). Ported VERBATIM from src/qa/learning/structural-pattern.ts's detectStructuralPatterns
// (the SAME detection regexes already ported once for change-analysis's static-signal fallback,
// qa-engine/src/contexts/change-analysis/infrastructure/extractors/structural-pattern.ts — kept as
// its OWN copy here rather than an inter-context import, mirroring error-class.ts's own "re-homed,
// not imported cross-context" convention: qa-run-orchestration/cross-run-learning never import each
// OTHER's infrastructure/domain internals across the hexagonal boundary, only ports).
//
// IMPORTANT — this is NOT "porting a legacy errorClass->archetype mapping": no such mapping exists.
// Verified against the live legacy tree: distillReflection/distillReviewerCorrections (the only
// legacy callers that accept an `archetype` field) have ZERO production callers — every legacy
// LearningRule.archetype was ALSO always null in production, for the exact same reason this port
// closes (no caller ever threaded detectStructuralPatterns' output into a distilled rule). Deriving
// archetype FROM errorClass would conflate two independent taxonomies and pollute
// RuleGovernanceService's relevance bias (which scores errorClass and archetype matches
// SEPARATELY, +3 each) with a fabricated, redundant signal — see rule-governance.service.ts's own
// header on why archetype must come from the diff's shape, never the error taxonomy.
function detectArchetypeKinds(diff: string, changedFiles: readonly string[]): string[] {
  const kinds: string[] = [];
  const diffText = diff.toLowerCase();

  const hasHtmlForm = changedFiles.some((f) => f.endsWith(".html")) && /<form\b/i.test(diff);
  const hasTsxForm = changedFiles.some((f) => f.endsWith(".tsx") || f.endsWith(".jsx")) && /<form\b|formgroup|formcontrol|formbuilder/i.test(diff);
  if (hasHtmlForm || hasTsxForm) kinds.push("form");

  const hasApiCall = /\b(?:fetch|axios|got|request|http\.(?:get|post|put|delete|patch)|usequery|usemutation|createApi)\b/i.test(diffText);
  if (hasApiCall) kinds.push("api-call");

  const hasCache = /\b(?:cache|cached|memoize|memo|usememo|usecallback|redis|localstorage|sessionstorage|indexeddb)\b/i.test(diffText);
  if (hasCache) kinds.push("stateful-cache");

  const hasAuth = /\b(?:auth|login|signin|logout|signout|session|token|jwt|oauth)\b/i.test(diffText);
  if (hasAuth) kinds.push("auth-flow");

  const hasList = /\b(?:list|table|datagrid|datatable|items|results|rows)\b/i.test(diffText);
  if (hasList) kinds.push("data-list");

  if (kinds.length === 0) kinds.push("generic");
  return kinds;
}

// Returns the FIRST matched structural-pattern kind (mirrors this module's own "first match wins"
// convention, e.g. errorClassFromCorrections in error-class.ts) as a single archetype tag, or null
// when there is no diff to analyze (absent/empty — a non-diff-mode run, or a run whose diff was
// never captured). Never fabricates a shape from nothing: null is the honest "unknown" signal,
// exactly like every other "never ran" field this codebase's RunOutcome.gateSignals convention uses.
export function detectArchetype(diff: string | undefined, changedFiles: readonly string[]): string | null {
  if (!diff) return null;
  const kinds = detectArchetypeKinds(diff, changedFiles);
  return kinds[0] ?? null;
}

// ── WS1.5: reviewer-correction -> ErrorClass (the corrections distillation channel) ─────────────
// Ported from legacy src/qa/learning/distiller.ts's correctionToRuleUpsert error-class derivation:
// prefer the SAME closed-vocabulary [tag] the reviewer is instructed to prefix each correction with
// (qa-reviewer.md's Output format contract), falling back to the keyword heuristics, falling back
// to E-REVIEWER-REJECTED when nothing is recognized. This is DISTINCT from error-class.ts's
// resolveErrorClass (qa-run-orchestration's own port): neither that port nor legacy's labeler.ts
// EVER assigns E-REVIEWER-REJECTED — it exists ONLY as this distillation fallback, the correct
// "catch-all" semantics legacy's taxonomy.ts comment describes ("reviewer rejection with no
// recognizable anti-pattern -> E-REVIEWER-REJECTED", src/qa/learning/taxonomy.ts:7).
const AP_FALSE_POSITIVE = /\b(?:asserts? nothing|asserts? 200|no real assertion|test clicks? without asserting|false positive|green noise|trivial assert|passes? when feature is broken)\b/i;
const AP_WRONG_OBJECTIVE = /\b(?:not tied to the (?:commit|change|diff)|misses? the (?:change|intent|objective)|tests? the wrong thing|irrelevant to the diff|does not test the change)\b/i;
const AP_FRAGILE_SELECTOR = /\b(?:fragile selector|ambiguous (?:selector|regex|locator)|text selector|nth-child|hardcoded index|brittle locator|magic string)\b/i;
const AP_NO_CLEANUP = /\b(?:no cleanup|does not clean up|orphaned (?:data|test data)|pollutes? DEV|missing cleanup|test data left behind)\b/i;

const TAG_TO_CLASS: Record<string, string> = {
  "false-positive": "E-FALSE-POSITIVE",
  "wrong-objective": "E-WRONG-OBJECTIVE",
  "fragile-selector": "E-FRAGILE-SELECTOR",
  "no-cleanup": "E-NO-CLEANUP",
};

function classifyReviewerCorrection(correction: string): string | null {
  const tag = /^\s*\[([a-z][a-z-]*)\]/i.exec(correction)?.[1]?.toLowerCase();
  if (tag) {
    const mapped = TAG_TO_CLASS[tag];
    if (mapped) return mapped;
    if (tag === "other") return null; // explicitly classified as "none of the buckets" — do not re-guess
    // an unrecognized tag (typo) falls through to the keyword heuristics below
  }
  if (AP_FALSE_POSITIVE.test(correction)) return "E-FALSE-POSITIVE";
  if (AP_WRONG_OBJECTIVE.test(correction)) return "E-WRONG-OBJECTIVE";
  if (AP_FRAGILE_SELECTOR.test(correction)) return "E-FRAGILE-SELECTOR";
  if (AP_NO_CLEANUP.test(correction)) return "E-NO-CLEANUP";
  return null;
}

// Derives the ErrorClass for a SINGLE reviewer correction, falling back to E-REVIEWER-REJECTED when
// no anti-pattern (tagged or keyword-matched) is recognized — mirrors legacy's
// correctionToRuleUpsert's `errorClassFromCorrections([text]) ?? "E-REVIEWER-REJECTED"` exactly.
export function correctionToErrorClass(correction: string): string {
  return classifyReviewerCorrection(correction) ?? "E-REVIEWER-REJECTED";
}

// qa-engine/src/contexts/qa-run-orchestration/domain/helpers/error-class.ts
// PORT (VERBATIM, not a rewrite) of src/qa/learning/taxonomy.ts's errorClassFromVerdict +
// errorClassFromCorrections + src/qa/learning/labeler.ts's resolveErrorClass — the deterministic,
// zero-LLM error taxonomy the legacy derives on every persisted RunOutcome (labelRunOutcome ->
// resolveErrorClass, src/qa/learning/labeler.ts:24/50-69) and RunQaUseCase.toRunOutcome() must
// derive too (Judgment-day D.7 FIX 4): hardcoding errorClass:null breaks the learning/governance
// flywheel, which reads errorClass for rule retrieval (src/pipeline.ts's retrieveRules/
// recentErrorClass/preventionOutcome, all keyed on this field).
//
// Re-homed here rather than imported cross-context: qa-run-orchestration MUST NOT import
// src/qa/learning/* directly (the same hexagonal-boundary rule that governs adjudicate.service.ts's
// re-home, progress-gate.ts's re-home, and every other Task D re-port before it). A dedicated
// error-class-parity.test.ts (added to the qa-engine typecheck "exclude" list) pins THIS copy
// against src/qa/learning/taxonomy.ts + src/qa/learning/labeler.ts directly.
//
// Scope note: only the PURE ErrorClass-derivation logic is re-ported — not labelRunOutcome() itself
// (that legacy function also builds the full RunOutcome shape, which RunQaUseCase.toRunOutcome()
// already owns). errorClassFromCorrections is included for completeness/parity fidelity; the
// verbatim reviewer-correction taxonomy classifier lets the SAME resolveErrorClass control flow
// (verdict-derived classes short-circuit first, then reviewer corrections, then coverage-gap, then
// the value-oracle E-VALUE-SURVIVED band) run unabridged, not partially copied.
//
// WS1.5 (full-flow remediation): CLOSED — RunQaUseCase.deriveErrorClass() now threads the review
// loop's real final-round corrections (finalReviewerCorrections in run-qa.use-case.ts) instead of a
// hardcoded []. E-FALSE-POSITIVE/E-WRONG-OBJECTIVE/E-FRAGILE-SELECTOR/E-NO-CLEANUP are derivable
// end-to-end from a genuine reviewer rejection. E-REVIEWER-REJECTED (the catch-all for an untagged/
// unrecognized correction) is NOT produced by resolveErrorClass itself — neither this port nor the
// legacy labeler.ts ever assigns it (verified: grep shows zero production assignment sites in
// src/qa/learning/labeler.ts). It is exclusively the corrections-DISTILLATION fallback (legacy
// src/qa/learning/distiller.ts's correctionToRuleUpsert, ported to cross-run-learning/domain/
// distill-rule.ts's correctionToRuleUpsert) — a different call site from this one.
//
// E-INFRA is recorded but EXCLUDED from learning (infrastructure failures teach nothing) — this is
// the legacy taxonomy's own documented behavior (src/qa/learning/taxonomy.ts:11), preserved verbatim.

export const ERROR_CLASSES = [
  "E-STATIC",
  "E-EXEC-FAIL",
  "E-FLAKY",
  "E-COVERAGE-GAP",
  "E-FALSE-POSITIVE",
  "E-WRONG-OBJECTIVE",
  "E-FRAGILE-SELECTOR",
  "E-NO-CLEANUP",
  "E-REVIEWER-REJECTED",
  "E-VALUE-SURVIVED",
  "E-INFRA",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

// Reviewer anti-pattern (AP) keywords — VERBATIM copy of src/qa/learning/taxonomy.ts's regexes.
const AP_FALSE_POSITIVE = /\b(?:asserts? nothing|asserts? 200|no real assertion|test clicks? without asserting|false positive|green noise|trivial assert|passes? when feature is broken)\b/i;
const AP_WRONG_OBJECTIVE = /\b(?:not tied to the (?:commit|change|diff)|misses? the (?:change|intent|objective)|tests? the wrong thing|irrelevant to the diff|does not test the change)\b/i;
const AP_FRAGILE_SELECTOR = /\b(?:fragile selector|ambiguous (?:selector|regex|locator)|text selector|nth-child|hardcoded index|brittle locator|magic string)\b/i;
const AP_NO_CLEANUP = /\b(?:no cleanup|does not clean up|orphaned (?:data|test data)|pollutes? DEV|missing cleanup|test data left behind)\b/i;

const TAG_TO_CLASS: Record<string, ErrorClass> = {
  "false-positive": "E-FALSE-POSITIVE",
  "wrong-objective": "E-WRONG-OBJECTIVE",
  "fragile-selector": "E-FRAGILE-SELECTOR",
  "no-cleanup": "E-NO-CLEANUP",
};

function classifyReviewerCorrection(correction: string): ErrorClass | null {
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

// Derive the dominant ErrorClass from the reviewer's corrections array. When multiple anti-patterns
// are present, the FIRST match wins (reviewer lists the most critical first). Returns null when no
// anti-pattern is recognized.
export function errorClassFromCorrections(corrections: string[]): ErrorClass | null {
  for (const c of corrections) {
    const cls = classifyReviewerCorrection(c);
    if (cls) return cls;
  }
  return null;
}

// Derive the ErrorClass from the pipeline's verdict alone (no reviewer input). Covers the
// structural classes (E-STATIC, E-EXEC-FAIL, E-FLAKY, E-INFRA, E-COVERAGE-GAP) that are fully
// determined by the gates.
export function errorClassFromVerdict(
  verdict: string,
  coverageRatio: number | null,
  minRatio: number,
): ErrorClass | null {
  switch (verdict) {
    case "invalid":
      return "E-STATIC";
    case "fail":
      return "E-EXEC-FAIL";
    case "flaky":
      return "E-FLAKY";
    case "infra-error":
      return "E-INFRA";
    case "pass":
      // Green runs can still have a coverage gap.
      if (coverageRatio !== null && coverageRatio < minRatio) return "E-COVERAGE-GAP";
      return null; // healthy green → no error class
    case "skipped":
      return null; // skipped runs teach nothing
    default:
      return null;
  }
}

export interface ResolveErrorClassInput {
  verdict: string;
  coverageRatio: number | null;
  minCoverageRatio: number;
  reviewerCorrections: string[];
  valueScore?: number | null;
}

// PORT (VERBATIM control flow) of src/qa/learning/labeler.ts's resolveErrorClass: verdict-derived
// structural classes short-circuit first (E-INFRA/E-STATIC/E-EXEC-FAIL/E-FLAKY), then reviewer
// corrections, then the verdict's own E-COVERAGE-GAP band, then the value-oracle E-VALUE-SURVIVED
// band (green + good coverage but mutants survive — the deepest false positive).
export function resolveErrorClass(input: ResolveErrorClassInput): ErrorClass | null {
  const fromVerdict = errorClassFromVerdict(input.verdict, input.coverageRatio, input.minCoverageRatio);

  if (fromVerdict === "E-INFRA") return "E-INFRA";
  if (fromVerdict === "E-STATIC") return "E-STATIC";
  if (fromVerdict === "E-EXEC-FAIL") return "E-EXEC-FAIL";
  if (fromVerdict === "E-FLAKY") return "E-FLAKY";

  const fromReviewer = errorClassFromCorrections(input.reviewerCorrections);
  if (fromReviewer) return fromReviewer;

  if (fromVerdict === "E-COVERAGE-GAP") return "E-COVERAGE-GAP";

  // E-VALUE-SURVIVED: green + good coverage but mutants survive (the deepest false positive)
  if (input.verdict === "pass" && input.valueScore !== null && input.valueScore !== undefined && input.valueScore < 0.5) {
    return "E-VALUE-SURVIVED";
  }

  return null;
}

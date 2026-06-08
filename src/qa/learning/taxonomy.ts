// Auto-labelable error taxonomy, zero LLM. Derived from the gates that already
// exist (B/C/D in pipeline.ts) and the reviewer's anti-pattern catalog.
//
// Each ErrorClass maps to a specific, deterministic signal:
//   - verdict + gate failures → structural classes (E-STATIC, E-EXEC-FAIL, …)
//   - reviewer corrections → quality classes (E-FALSE-POSITIVE, E-WRONG-OBJECTIVE, …)
//   - change-coverage gap → E-COVERAGE-GAP
//   - mutation/benchmark (Fase 1) → E-VALUE-SURVIVED
//
// E-INFRA is recorded but EXCLUDED from learning (infrastructure failures teach nothing).

export const ERROR_CLASSES = [
  "E-STATIC",
  "E-EXEC-FAIL",
  "E-FLAKY",
  "E-COVERAGE-GAP",
  "E-FALSE-POSITIVE",
  "E-WRONG-OBJECTIVE",
  "E-FRAGILE-SELECTOR",
  "E-NO-CLEANUP",
  "E-VALUE-SURVIVED",
  "E-INFRA",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

// Reviewer anti-pattern (AP) keywords. The reviewer's corrections carry human-readable
// descriptions; these substrings map the most common ones to ErrorClass buckets.
// Derived from opencode/skill/test-value-review/SKILL.md anti-pattern catalog.

const AP_FALSE_POSITIVE = /\b(?:asserts? nothing|asserts? 200|no real assertion|test clicks? without asserting|false positive|green noise|trivial assert|passes? when feature is broken)\b/i;
const AP_WRONG_OBJECTIVE = /\b(?:not tied to the (?:commit|change|diff)|misses? the (?:change|intent|objective)|tests? the wrong thing|irrelevant to the diff|does not test the change)\b/i;
const AP_FRAGILE_SELECTOR = /\b(?:fragile selector|ambiguous (?:selector|regex|locator)|text selector|nth-child|hardcoded index|brittle locator|magic string)\b/i;
const AP_NO_CLEANUP = /\b(?:no cleanup|does not clean up|orphaned (?:data|test data)|pollutes? DEV|missing cleanup|test data left behind)\b/i;

// Match ANY anti-pattern keyword in a reviewer correction string.
// Returns the ErrorClass if matched, null otherwise.
function classifyReviewerCorrection(correction: string): ErrorClass | null {
  if (AP_FALSE_POSITIVE.test(correction)) return "E-FALSE-POSITIVE";
  if (AP_WRONG_OBJECTIVE.test(correction)) return "E-WRONG-OBJECTIVE";
  if (AP_FRAGILE_SELECTOR.test(correction)) return "E-FRAGILE-SELECTOR";
  if (AP_NO_CLEANUP.test(correction)) return "E-NO-CLEANUP";
  return null;
}

// Derive the dominant ErrorClass from the reviewer's corrections array. When
// multiple anti-patterns are present, the FIRST match wins (reviewer lists the
// most critical first). Returns null when no anti-pattern is recognized.
export function errorClassFromCorrections(corrections: string[]): ErrorClass | null {
  for (const c of corrections) {
    const cls = classifyReviewerCorrection(c);
    if (cls) return cls;
  }
  return null;
}

// Derive the ErrorClass from the pipeline's verdict alone (no reviewer input).
// This covers the structural classes (E-STATIC, E-EXEC-FAIL, E-FLAKY,
// E-INFRA, E-COVERAGE-GAP) that are fully determined by the gates.
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

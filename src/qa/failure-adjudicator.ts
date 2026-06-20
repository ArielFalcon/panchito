// Pure decision function that adjudicates a failing QA run and determines the appropriate
// action for the pipeline's fix-loop. Replaces the two ad-hoc branches in pipeline.ts
// (~2048-2060) with a single deterministic call.
//
// Decision precedence (first match wins):
//   1. runner_infra — all failure details match the Playwright launcher infra pattern
//   2. dev_infra    — DEV health check failed (pre-computed boolean, no I/O here)
//   3. app_defect   — isLikelyRealBug fires (exact parity, calls the same predicate)
//   4. generated_test_defect/continue — absent selector or all-locator class + spend allowed
//   5. break-needs-human — gate closed and no deterministic class above fired (ambiguous)
//   6. objective_gap (inert) — zero file-overlap in diff mode (label only, action=continue)
//   7. default — generated_test_defect/low/continue (existing fall-through behaviour)
//
// All functions are pure: no I/O, no async, never throw. Pattern mirrors progress-gate.ts.

import { classifyFailure, isLikelyRealBug } from "./progress-gate";
import { PLAYWRIGHT_INFRA_RE } from "./execute";
import type { RunMode } from "../types";

// ── Const-object enums → derived union types (TS skill: const-object pattern) ──

export const ADJ_CLASS = {
  APP_DEFECT: "app_defect",
  GENERATED_TEST_DEFECT: "generated_test_defect",
  RUNNER_INFRA: "runner_infra",
  DEV_INFRA: "dev_infra",
  OBJECTIVE_GAP: "objective_gap",
} as const;
export type AdjudicatorClass = (typeof ADJ_CLASS)[keyof typeof ADJ_CLASS];

export const ADJ_CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;
export type AdjudicatorConfidence = (typeof ADJ_CONFIDENCE)[keyof typeof ADJ_CONFIDENCE];

export const ADJ_ACTION = {
  BREAK_ISSUE: "break-issue",
  BREAK_NEEDS_HUMAN: "break-needs-human",
  CONTINUE: "continue",
} as const;
export type AdjudicatorAction = (typeof ADJ_ACTION)[keyof typeof ADJ_ACTION];

// classifyFailure's return type re-exported as an alias so callers can type the
// precomputed failureClasses array without importing a literal union directly.
export type AdjFailureClass = ReturnType<typeof classifyFailure>;

// ── Evidence and verdict types ─────────────────────────────────────────────────

// All fields are pre-computed by the caller. The function performs no I/O.
export interface AdjudicatorEvidence {
  /** True for code-mode runs (no web env): skips app_defect and objective_gap rules. */
  isCode: boolean;
  /** True when every proposed selector was present+unique in the failure-point snapshot. */
  allUnique: boolean;
  /** Failure detail strings from failed cases: `failed.map(c => c.detail ?? "")`. */
  failureDetails: string[];
  /** Per-detail failure class: `failed.map(c => classifyFailure(c.detail ?? ""))`. */
  failureClasses: AdjFailureClass[];
  /** Number of verifiable-absent selectors (Lever-2 absentKeys.size). */
  absentKeysCount: number;
  /** True if the fix-loop may spend another retry (decideProgress.spend). */
  gateSpend: boolean;
  /** Human-readable gate decision reason (carried into verdict.reason). */
  gateReason: string;
  /** Pre-computed DEV health: true for code mode (no web env) or when DEV is responding. */
  devHealthy: boolean;
  /** Run mode from RunOptions.mode. */
  mode: RunMode;
  /** Diff mode: intent.changedFiles; manual mode: [opts.guidance] (filtered non-empty). */
  objectiveSource: string[];
  /** Failing case file basenames: `failed.map(c => c.file)` (may contain undefined). */
  failingFiles: (string | undefined)[];
}

export interface AdjudicatorVerdict {
  class: AdjudicatorClass;
  confidence: AdjudicatorConfidence;
  action: AdjudicatorAction;
  /** Human-legible explanation threaded into Issue labels/body for observability. */
  reason: string;
}

// ── Pure decision function ─────────────────────────────────────────────────────

/**
 * Adjudicates a failing run iteration. Pure, sync, never throws.
 * Returns the first matching rule's verdict.
 */
export function adjudicate(evidence: AdjudicatorEvidence): AdjudicatorVerdict {
  const {
    isCode,
    allUnique,
    failureDetails,
    failureClasses,
    absentKeysCount,
    gateSpend,
    gateReason,
    devHealthy,
    mode,
    objectiveSource,
    failingFiles,
  } = evidence;

  // Rule 1: runner_infra — every failure matches the Playwright launcher infra pattern.
  // Mirrors allFailuresAreRunnerInfra exactly (same regex, applied per-detail string).
  // Highest priority: never burn retries on a phantom bug caused by a launcher crash.
  if (failureDetails.length > 0 && failureDetails.every((d) => PLAYWRIGHT_INFRA_RE.test(d))) {
    return {
      class: ADJ_CLASS.RUNNER_INFRA,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE, // caller routes to infra-error, no repo Issue
      reason: "Playwright runner infrastructure failure — browser could not launch",
    };
  }

  // Rule 2: dev_infra — DEV health check failed (pre-computed; no I/O here).
  // Sits above app_defect so a runner crash during DEV downtime doesn't blame the app.
  if (devHealthy === false) {
    return {
      class: ADJ_CLASS.DEV_INFRA,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE, // caller routes to infra-error, no repo Issue
      reason: "DEV environment unhealthy — failures are infra-related, not code defects",
    };
  }

  // Rule 3: app_defect — exact parity with isLikelyRealBug (calls the proven predicate,
  // no re-implementation). allUnique=true + every detail a value-mismatch → real bug.
  // Not applicable in code mode (no selector-presence concept there).
  if (!isCode && isLikelyRealBug(allUnique, failureDetails)) {
    return {
      class: ADJ_CLASS.APP_DEFECT,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE,
      reason: `App defect detected: selectors unique + all failures are value mismatches. ${gateReason}`,
    };
  }

  // Rule 4: generated_test_defect/continue — clear test-side fault AND progress still
  // possible (gateSpend=true). Only fires when not code mode (locators only apply to E2E).
  // Does NOT fire when gateSpend=false → falls through to rule 5 (the asymmetric stop).
  if (
    !isCode &&
    (absentKeysCount > 0 || failureClasses.every((c) => c === "locator")) &&
    gateSpend === true
  ) {
    return {
      class: ADJ_CLASS.GENERATED_TEST_DEFECT,
      confidence: ADJ_CONFIDENCE.MEDIUM,
      action: ADJ_ACTION.CONTINUE,
      reason: `Test defect: ${absentKeysCount > 0 ? `${absentKeysCount} absent selector(s)` : "all failures are locator errors"} — retrying with grounding feedback`,
    };
  }

  // Rule 5: break-needs-human — gate is closed and no deterministic class above fired.
  // The asymmetric safety rule: falsely regenerating away a possibly-real failing test is
  // worse than surfacing a labeled Issue for a human to triage.
  // Preserves today's `!gate.spend → break` behaviour but with a labeled Issue.
  if (gateSpend === false) {
    // Use the most informative available class for the label.
    const ambiguousClass = ADJ_CLASS.GENERATED_TEST_DEFECT; // best label for mixed/other
    return {
      class: ambiguousClass,
      confidence: ADJ_CONFIDENCE.LOW,
      action: ADJ_ACTION.BREAK_NEEDS_HUMAN,
      reason: `No progress and ambiguous failure — stopping fix-loop for human review. Gate: ${gateReason}`,
    };
  }

  // Rule 6: objective_gap (inert) — diff mode, zero file-basename overlap between the
  // failing test files and the changed files. Label only; action is always continue.
  // Sits last so it can only attach a label to a verdict that would continue anyway.
  if (
    !isCode &&
    mode === "diff" &&
    objectiveSource.length > 0 &&
    failingFiles.length > 0 &&
    failingFiles.every((f) => !!f) &&
    noBasenameOverlap(failingFiles as string[], objectiveSource)
  ) {
    return {
      class: ADJ_CLASS.OBJECTIVE_GAP,
      confidence: ADJ_CONFIDENCE.LOW,
      action: ADJ_ACTION.CONTINUE, // NEVER gates — purely observability
      reason: "Zero basename overlap between failing test files and changed diff files — possible objective mismatch",
    };
  }

  // Default: generated_test_defect/low/continue — equivalent to today's fall-through-and-
  // regenerate behaviour (neither branch fired, keep looping).
  return {
    class: ADJ_CLASS.GENERATED_TEST_DEFECT,
    confidence: ADJ_CONFIDENCE.LOW,
    action: ADJ_ACTION.CONTINUE,
    reason: `Ambiguous failure — continuing fix-loop. Gate: ${gateReason}`,
  };
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Returns true when no basename in `files` overlaps any basename in `sources`.
 * Uses the same normalization pattern the pipeline uses at the regen basename check.
 */
function noBasenameOverlap(files: string[], sources: string[]): boolean {
  const bn = (s: string): string => s.replace(/.*\//, "").replace(/.*\\/, "");
  const sourceBasenames = new Set(sources.map(bn));
  return files.every((f) => !sourceBasenames.has(bn(f)));
}

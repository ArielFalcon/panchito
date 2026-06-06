// Pure presentation helpers — no Ink, no React. These hold the formatting logic so
// it is unit-testable in isolation; the components only place these strings/colors.

import { RunVerdict, CaseStatus, TestTarget, RunMode } from "../types";

// The visible pipeline (the OpenCode-internal generate↔review loop stays opaque).
export const PIPELINE_STEPS = ["classify", "generate", "validate", "execute"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export type StepState = "done" | "active" | "pending";

// Target descriptions (sourced from types.ts doc comments).
export const TARGET_INFO: Record<TestTarget, string> = {
  e2e: "Browser-based Playwright tests against a live DEV environment",
  code: "Source-code tests (unit/integration) without a browser or DEV URL",
};

// Mode descriptions — what each mode does at a glance.
export const MODE_INFO: Record<RunMode, string> = {
  diff:        "Test the blast radius of a single commit (default). Classifies Conventional Commits to skip, regress, or generate.",
  complete:    "Analyze the whole repo, estimate coverage, and test uncovered important flows.",
  exhaustive:  "Audit every existing test and regenerate the entire suite from scratch.",
  manual:      "Focused generation guided by a natural-language prompt.",
};

// Section label for each pipeline step, with a summary when complete.
export function sectionLabel(step: PipelineStep, state: StepState, cases: { passed: number; failed: number; total: number }, specCount?: number): string {
  const labels: Record<PipelineStep, string> = {
    classify: "classify commit",
    generate: "generate tests",
    validate: "validate specs",
    execute:  "execute tests",
  };
  if (state === "done") {
    if (step === "execute" && cases.total > 0) {
      return `${labels[step]} — ${cases.total} run, ${cases.passed} passed, ${cases.failed} failed`;
    }
    if (step === "generate" && specCount !== undefined && specCount > 0) {
      return `${labels[step]} — ${specCount} spec${specCount !== 1 ? "s" : ""}`;
    }
    return labels[step];
  }
  return labels[step];
}

// Given the run's current `step`, what state should `step` render in?
export function stepState(current: string | undefined, step: PipelineStep): StepState {
  if (current === "done") return "done";
  const execIdx = PIPELINE_STEPS.indexOf("execute");
  if (current === "retry") {
    return step === "execute" ? "active" : PIPELINE_STEPS.indexOf(step) < execIdx ? "done" : "pending";
  }
  const ci = current ? PIPELINE_STEPS.indexOf(current as PipelineStep) : -1;
  const si = PIPELINE_STEPS.indexOf(step);
  if (ci < 0) return "pending"; // enqueued / unknown
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

// A 20-wide block progress bar. passed/total clamped; 0 total → empty bar.
export function progressBar(passed: number, total: number, width = 20): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((passed / total) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function verdictColor(verdict: RunVerdict | undefined): string {
  switch (verdict) {
    case "pass":
      return "#3b7a57";
    case "fail":
    case "invalid":
      return "#c0392b";
    case "skipped":
      return "#6b685b";
    case "flaky":
      return "#c2891b";
    case "infra-error":
      return "#4a6877";
    default:
      return "cyan";
  }
}

export function verdictIcon(verdict: RunVerdict | undefined): string {
  switch (verdict) {
    case "pass":
      return "✓";
    case "fail":
    case "invalid":
      return "✗";
    case "skipped":
      return "⊘";
    case "flaky":
      return "⚠";
    case "infra-error":
      return "⚙";
    default:
      return "·";
  }
}

export function caseColor(status: CaseStatus): string {
  return status === "fail" ? "#c0392b" : status === "flaky" ? "#c2891b" : "#6b685b";
}

export function caseIcon(status: CaseStatus): string {
  return status === "fail" ? "✗" : status === "flaky" ? "⚠" : "✓";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

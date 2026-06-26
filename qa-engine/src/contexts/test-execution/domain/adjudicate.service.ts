// Pure, precedence-ordered failure classification — lifted from execute.ts
// (allFailuresAreRunnerInfra + PLAYWRIGHT_INFRA_RE). Stateless computation over evidence:
// a `fail` where EVERY failed case is a runner-infrastructure fault is reclassified to
// infra-error (the run never exercised the app); a single genuine failure keeps it `fail`.
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { AppDefect } from "./app-defect.ts";

// Carried VERBATIM from execute.ts PLAYWRIGHT_INFRA_RE (narrow launch/host signatures only;
// "Target ... closed" is deliberately excluded — that is a real app crash the test must surface).
export const PLAYWRIGHT_INFRA_RE =
  /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;

export interface AdjudicationResult {
  readonly verdict: RunVerdict;
  readonly appDefect: AppDefect;
}

export class AdjudicateService {
  // True when the run failed but EVERY failed case is a runner-infra fault. Carried from
  // execute.ts allFailuresAreRunnerInfra — conservative: a single genuine failure keeps `fail`.
  private allFailuresAreRunnerInfra(cases: readonly QaCase[]): boolean {
    const failed = cases.filter((c) => c.status === "fail");
    return failed.length > 0 && failed.every((c) => PLAYWRIGHT_INFRA_RE.test(c.detail ?? ""));
  }

  adjudicate(verdict: RunVerdict, cases: readonly QaCase[]): AdjudicationResult {
    if (verdict === "fail" && this.allFailuresAreRunnerInfra(cases)) {
      const first = cases.find((c) => c.status === "fail");
      return { verdict: "infra-error", appDefect: AppDefect.fromRunnerInfra(first?.detail ?? "") };
    }
    return { verdict, appDefect: AppDefect.none() };
  }
}

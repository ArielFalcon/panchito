import type { RunOutcome } from "../../types";
import type { RunMode, RunVerdict, TestTarget } from "../../types";
import { errorClassFromVerdict, errorClassFromCorrections, type ErrorClass } from "./taxonomy";

export interface LabelerInput {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  staticOk: boolean;
  coverageRatio: number | null;
  minCoverageRatio: number;
  reviewerCorrections: string[];
  reviewerRationale?: string;
  reviewerApproved?: boolean | null;
  flaky: boolean;
  retries: number;
  valueScore?: number | null;
}

export function labelRunOutcome(input: LabelerInput): RunOutcome {
  const errorClass = resolveErrorClass(input);
  const at = new Date().toISOString();

  return {
    runId: input.runId,
    app: input.app,
    sha: input.sha,
    mode: input.mode,
    target: input.target,
    verdict: input.verdict,
    errorClass,
    gateSignals: {
      static: input.staticOk,
      coverageRatio: input.coverageRatio,
      valueScore: null,
      reviewerCorrections: input.reviewerCorrections,
      ...(input.reviewerRationale !== undefined ? { reviewerRationale: input.reviewerRationale } : {}),
      ...(input.reviewerApproved !== undefined && input.reviewerApproved !== null ? { reviewerApproved: input.reviewerApproved } : {}),
      flaky: input.flaky,
      retries: input.retries,
    },
    rulesRetrieved: [],
    at,
  };
}

function resolveErrorClass(input: LabelerInput): ErrorClass | null {
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

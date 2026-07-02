import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the re-ported error-class helpers (Judgment-day D.7 FIX 4's dependency) must match
// src/qa/learning/taxonomy.ts + src/qa/learning/labeler.ts's resolveErrorClass across a sample
// table — qa-run-orchestration must not import src/qa/learning/* directly, so this is a SEPARATE
// re-port, not a re-use of the legacy module. This file imports src/qa/learning/taxonomy.ts +
// src/qa/learning/labeler.ts, so it is added to the qa-engine typecheck "exclude" list (same
// parity-import pattern as progress-gate-parity.test.ts / adjudicate-parity.test.ts).
import {
  errorClassFromVerdict,
  errorClassFromCorrections,
  resolveErrorClass,
} from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import {
  errorClassFromVerdict as legacyErrorClassFromVerdict,
  errorClassFromCorrections as legacyErrorClassFromCorrections,
} from "../../../../../../src/qa/learning/taxonomy.ts";
import { labelRunOutcome as legacyLabelRunOutcome } from "../../../../../../src/qa/learning/labeler.ts";

// Legacy resolveErrorClass is module-private (not exported by labeler.ts) — probe it indirectly
// through the exported labelRunOutcome(), reading back the errorClass field it computes.
function legacyResolveErrorClass(input: {
  verdict: string;
  coverageRatio: number | null;
  minCoverageRatio: number;
  reviewerCorrections: string[];
  valueScore?: number | null;
}): string | null {
  const outcome = legacyLabelRunOutcome({
    runId: "parity-probe",
    app: "parity-app",
    sha: "deadbeef",
    mode: "diff",
    target: "e2e",
    verdict: input.verdict as never,
    staticOk: true,
    coverageRatio: input.coverageRatio,
    minCoverageRatio: input.minCoverageRatio,
    reviewerCorrections: input.reviewerCorrections,
    flaky: input.verdict === "flaky",
    retries: 0,
    valueScore: input.valueScore ?? null,
  });
  return outcome.errorClass;
}

test("PARITY: errorClassFromVerdict matches legacy across every verdict + coverage-ratio band", () => {
  const samples: Array<{ verdict: string; coverageRatio: number | null; minRatio: number }> = [
    { verdict: "invalid", coverageRatio: null, minRatio: 0.7 },
    { verdict: "fail", coverageRatio: null, minRatio: 0.7 },
    { verdict: "flaky", coverageRatio: null, minRatio: 0.7 },
    { verdict: "infra-error", coverageRatio: null, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: null, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: 0.5, minRatio: 0.7 },
    { verdict: "pass", coverageRatio: 0.9, minRatio: 0.7 },
    { verdict: "skipped", coverageRatio: null, minRatio: 0.7 },
    { verdict: "unknown-verdict", coverageRatio: null, minRatio: 0.7 },
  ];
  for (const s of samples) {
    assert.equal(
      errorClassFromVerdict(s.verdict, s.coverageRatio, s.minRatio),
      legacyErrorClassFromVerdict(s.verdict, s.coverageRatio, s.minRatio),
      `verdict=${s.verdict} coverageRatio=${s.coverageRatio}`,
    );
  }
});

test("PARITY: errorClassFromCorrections matches legacy across tagged/untagged/other corrections", () => {
  const samples: string[][] = [
    ["[false-positive] login.spec.ts: asserts nothing meaningful"],
    ["[wrong-objective] does not test the change"],
    ["[fragile-selector] nth-child(2) hardcoded index"],
    ["[no-cleanup] leaves orphaned test data"],
    ["[other] a correction the reviewer chose not to classify"],
    ["an untagged correction mentioning a false positive test"],
    ["a totally unrecognizable correction"],
    [],
    ["[typo-tag] some correction", "fragile selector: nth-child(3)"],
  ];
  for (const s of samples) {
    assert.equal(
      errorClassFromCorrections(s),
      legacyErrorClassFromCorrections(s),
      `corrections=${JSON.stringify(s)}`,
    );
  }
});

test("PARITY: resolveErrorClass matches legacy's labelRunOutcome-derived errorClass across the full precedence chain", () => {
  const samples: Array<{
    verdict: string;
    coverageRatio: number | null;
    minCoverageRatio: number;
    reviewerCorrections: string[];
    valueScore?: number | null;
  }> = [
    { verdict: "invalid", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "fail", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "flaky", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "infra-error", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: 0.25, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [] },
    { verdict: "pass", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
    // Reviewer-correction-derived class does NOT override a verdict-derived structural class —
    // fail-issue with reviewer corrections still resolves E-EXEC-FAIL (verdict wins first).
    { verdict: "fail", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: ["[false-positive] x"] },
    // A pass with good coverage AND a low valueScore -> E-VALUE-SURVIVED.
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [], valueScore: 0.2 },
    // A pass with good coverage and a healthy valueScore -> clean (no error class).
    { verdict: "pass", coverageRatio: 0.95, minCoverageRatio: 0.7, reviewerCorrections: [], valueScore: 0.85 },
    { verdict: "skipped", coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] },
  ];
  for (const s of samples) {
    assert.equal(
      resolveErrorClass(s),
      legacyResolveErrorClass(s),
      `verdict=${s.verdict} coverageRatio=${s.coverageRatio} valueScore=${s.valueScore}`,
    );
  }
});

// test/characterization/shadow-comparison.test.ts
// RED-first (Task F.1): compareShadowRun reuses runOutcomeEquivalent (the golden-parity projection) and
// renders a report. Identical outcomes (modulo per-invocation runId/at) → equal:true; a verdict
// divergence → equal:false + a diff naming the field; an observed side-effect divergence → equal:false
// even when the outcomes themselves match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareShadowRun } from "./shadow-comparison.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run-1",
    app: "petclinic",
    sha: "abc1234",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: 0.9,
      valueScore: null,
      reviewerCorrections: [],
      reviewerApproved: true,
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

test("compareShadowRun reports EQUIVALENT for two outcomes that differ only in per-invocation fields", () => {
  const r = compareShadowRun(outcome({ runId: "legacy", at: "2026-07-02T00:00:01.000Z" }), outcome({ runId: "rewritten", at: "2026-07-02T00:00:02.000Z" }));
  assert.equal(r.equal, true);
  assert.equal(r.diff, undefined);
  assert.match(r.report, /EQUIVALENT/);
});

test("compareShadowRun flags a verdict divergence (pass vs fail) with a field-named diff", () => {
  const r = compareShadowRun(outcome({ verdict: "pass" }), outcome({ verdict: "fail" }));
  assert.equal(r.equal, false);
  assert.match(r.diff ?? "", /verdict/);
  assert.match(r.report, /DIVERGENT/);
});

test("compareShadowRun flags an observed side-effect divergence even when the outcomes match", () => {
  const r = compareShadowRun(outcome(), outcome(), { legacy: "shadow-log", rewritten: "pr" });
  assert.equal(r.equal, false);
  assert.match(r.diff ?? "", /sideEffect/);
  assert.match(r.report, /DIVERGENT/);
});

// LLM-non-determinism guard (the real shadow proof caught this on portfolio@26614bd): on a
// non-review verdict the independent reviewer never ran, so reviewerApproved is GENERATION's own
// self-approval — an LLM value two independent live runs will differ on even for identical engines.
test("compareShadowRun EXCLUDES reviewerApproved on a non-review verdict (invalid) — it is LLM self-approval noise there, not an engine decision", () => {
  const gs = { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 };
  const legacy = outcome({ verdict: "invalid", gateSignals: { ...gs, reviewerApproved: true } });
  const rewritten = outcome({ verdict: "invalid", gateSignals: { ...gs, reviewerApproved: false } });
  const r = compareShadowRun(legacy, rewritten);
  assert.equal(r.equal, true, "two live invalid runs differing only in the LLM's self-approval must NOT read as an engine divergence");
  assert.match(r.report, /EQUIVALENT/);
});

test("compareShadowRun STILL compares reviewerApproved when the reviewer ran (pass) — a real review-decision divergence is flagged", () => {
  const gs = { static: true, coverageRatio: 0.9, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 };
  const legacy = outcome({ verdict: "pass", gateSignals: { ...gs, reviewerApproved: true } });
  const rewritten = outcome({ verdict: "pass", gateSignals: { ...gs, reviewerApproved: false } });
  const r = compareShadowRun(legacy, rewritten);
  assert.equal(r.equal, false, "on a pass verdict a real review ran, so a reviewerApproved divergence IS a genuine decision divergence");
  assert.match(r.diff ?? "", /reviewerApproved/);
});

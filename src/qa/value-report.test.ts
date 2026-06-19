import { test } from "node:test";
import assert from "node:assert/strict";
import { renderValueTag, deriveAction, renderRunReport, type ValueSignals, type RunReportInput } from "./value-report";

const baseSignals: ValueSignals = {
  coverageRatio: null,
  coverageMeasured: false,
  valueScore: null,
  reviewerApproved: null,
};

// ── renderValueTag (always plain — embedded in an event payload) ─────────────────

test("value tag: measured coverage + oracle score are appended as numeric signals", () => {
  const tag = renderValueTag({ ...baseSignals, coverageMeasured: true, coverageRatio: 0.82, valueScore: 0.75 });
  assert.equal(tag, " · change-coverage 82% · value 75%");
});

test("value tag: only coverage when the oracle did not run (the shadow-mode default)", () => {
  const tag = renderValueTag({ ...baseSignals, coverageMeasured: true, coverageRatio: 0.5 });
  assert.equal(tag, " · change-coverage 50%");
});

test("value tag: empty when nothing was measured (never pollutes a clean outcome)", () => {
  assert.equal(renderValueTag(baseSignals), "");
  // unmeasured coverage must NOT surface a misleading 0%
  assert.equal(renderValueTag({ ...baseSignals, coverageMeasured: false, coverageRatio: 0 }), "");
});

test("value tag: reviewer verdict is NOT duplicated in the tag", () => {
  const tag = renderValueTag({ ...baseSignals, reviewerApproved: false, coverageMeasured: true, coverageRatio: 0.9 });
  assert.equal(tag, " · change-coverage 90%");
  assert.ok(!tag.includes("reviewer"));
});

// ── deriveAction ───────────────────────────────────────────────────────────────

test("deriveAction: a green reviewer-approved run opens an auto-merge PR", () => {
  assert.match(deriveAction("pass", true), /auto-merge suite PR/);
});

test("deriveAction: green but reviewer-rejected files an Issue, not a PR", () => {
  assert.match(deriveAction("pass", false), /file an Issue.*reviewer rejected/);
});

test("deriveAction: skipped and infra-error produce no side effect", () => {
  assert.match(deriveAction("skipped", null), /no test-worthy change/);
  assert.match(deriveAction("infra-error", null), /inconclusive/);
});

// ── renderRunReport (default: plain, deterministic) ──────────────────────────────

const baseReport: RunReportInput = {
  app: "petclinic",
  sha: "a1b2c3d4e5f6",
  mode: "diff",
  target: "e2e",
  shadow: true,
  verdict: "pass",
  passed: 3,
  failed: 0,
  specCount: 3,
  specNames: ["login", "add-owner", "add-pet"],
  signals: { coverageRatio: 0.82, coverageMeasured: true, coveragePolicy: "signal", valueScore: null, reviewerApproved: true, reviewerRationale: "covers the new validation branch" },
  errorClass: null,
};

test("run report: shadow green run frames the WOULD-do action and the value signals", () => {
  const out = renderRunReport(baseReport);
  assert.match(out, /run value report .* petclinic @ a1b2c3d4e/);
  assert.match(out, /✓ PASS/);
  assert.match(out, /3 passed · 0 failed/);
  assert.match(out, /SHADOW \(preview — no PR\/Issue\)/);
  assert.match(out, /action\s+would open an auto-merge suite PR/);
  assert.match(out, /produced\s+3 specs · login, add-owner, add-pet/);
  assert.match(out, /change-cov\s+82%\s+signal · measured/);
  assert.match(out, /oracle\s+off \(set valueOracle: signal/); // default-off (no oraclePolicy ⇒ off)
  assert.match(out, /reviewer\s+approved · covers the new validation branch/);
});

test("run report: default output is plain (no ANSI escapes) so pipes/redirects stay clean", () => {
  const out = renderRunReport(baseReport);
  assert.ok(!out.includes("\x1b["), "default render must contain no ANSI escape codes");
});

test("run report: color mode wraps the verdict in ANSI (matches the TUI palette)", () => {
  const out = renderRunReport(baseReport, { color: true });
  assert.ok(out.includes("\x1b["), "color render must contain ANSI escape codes");
  assert.match(out, /\x1b\[38;5;42m/); // green — the pass/approved color
});

test("run report: reviewer rejection surfaces the rationale (the keystone publish gate's reason)", () => {
  const out = renderRunReport({ ...baseReport, signals: { ...baseReport.signals, reviewerApproved: false, reviewerRationale: "assertions do not check the persisted owner" } });
  assert.match(out, /reviewer\s+rejected · assertions do not check the persisted owner/);
  assert.match(out, /action\s+would file an Issue \(the reviewer rejected the suite\)/);
});

test("run report: unmeasured coverage reads as 'not measured', never a false 0%", () => {
  const out = renderRunReport({ ...baseReport, signals: { ...baseReport.signals, coverageMeasured: false, coverageRatio: null } });
  assert.match(out, /change-cov\s+not measured \(unknown/);
  assert.ok(!/change-cov\s+0%/.test(out));
});

test("run report: non-shadow run says what it DID and shows a measured oracle score", () => {
  const out = renderRunReport({ ...baseReport, shadow: false, signals: { ...baseReport.signals, valueScore: 0.6 } });
  assert.ok(!out.includes("SHADOW"));
  assert.match(out, /action\s+open an auto-merge suite PR/);
  assert.match(out, /oracle\s+60% mutant-kill/);
});

// The oracle is ENABLED (valueOracle: signal) but produced no score this run — e.g. an
// infra-error/zero-spec run with no baseline-passing specs to score. The report must NOT say "off"
// (which would tell the operator to enable an already-enabled oracle); it says "enabled · no
// ground-truth this run". This is exactly the PetClinic-with-valueOracle-signal case.
test("run report: an ENABLED oracle with no score reads 'enabled · no ground-truth', not 'off'", () => {
  const out = renderRunReport({
    ...baseReport,
    verdict: "infra-error",
    signals: { ...baseReport.signals, oraclePolicy: "signal", valueScore: null },
  });
  assert.match(out, /oracle\s+enabled · no ground-truth this run/);
  assert.ok(!/oracle\s+off/.test(out), "must not tell the operator to enable an already-enabled oracle");
});

test("run report: a skipped run carries no specs and no side effect", () => {
  const out = renderRunReport({ ...baseReport, verdict: "skipped", passed: 0, failed: 0, specCount: 0, specNames: [], signals: baseSignals });
  assert.match(out, /produced\s+no new specs/);
  assert.match(out, /action\s+would skip the commit \(no test-worthy change\)/);
  assert.match(out, /• SKIPPED/);
});

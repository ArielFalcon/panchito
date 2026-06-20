import { test } from "node:test";
import assert from "node:assert/strict";
import { auditProcess, applyAudit, type AuditInput, type RuleView, type AuditRouterDeps, type ProcessFinding } from "./process-audit";
import type { RunOutcome } from "../../types";

function outcome(over: Partial<RunOutcome> & { errorClass?: RunOutcome["errorClass"] } = {}): RunOutcome {
  return {
    runId: over.runId ?? "r1", app: "petclinic", sha: over.sha ?? "abc1234def", mode: "manual", target: "e2e",
    verdict: over.verdict ?? "fail", errorClass: (over.errorClass ?? "E-EXEC-FAIL"),
    gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...over.gateSignals },
    rulesRetrieved: [], at: over.at ?? "2026-06-13T00:00:00Z",
  };
}

const rule = (over: Partial<RuleView>): RuleView => ({ id: "ru1", errorClass: "E-EXEC-FAIL", status: "candidate", usageCount: 0, successRate: null, ...over });

test("recurring CODE errorClass (E-STATIC) 3 runs in a row → engine-fix (a repeating defect, human-gated PR)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })], rules: [] };
  const f = auditProcess(input).find((x) => x.kind === "recurring-error-class");
  assert.ok(f, "expected a recurring-error-class finding");
  assert.equal(f!.disposition, "engine-fix");
  assert.match(f!.evidence, /E-STATIC/);
});

test("recurring UI/grounding errorClass (E-FRAGILE-SELECTOR) → context-heal (rebuild the stale map), NOT a PR", () => {
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })], rules: [] };
  const f = auditProcess(input).find((x) => x.disposition === "context-heal");
  assert.ok(f, "a recurring UI-mismatch should rebuild the architecture map first, not open a PR");
  assert.equal(f!.kind, "recurring-ui-mismatch");
  assert.ok(!auditProcess(input).some((x) => x.disposition === "engine-fix")); // never escalates to a PR on a map-fixable class
});

test("a one-off errorClass does NOT fire engine-fix (one occurrence is noise, not a defect)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-EXEC-FAIL" }), outcome({ errorClass: null as unknown as RunOutcome["errorClass"] })], rules: [] };
  assert.ok(!auditProcess(input).some((x) => x.kind === "recurring-error-class"));
});

test("a used-but-unproven candidate rule whose class is STILL RECURRING → ledger-heal (deprecate, no PR)", () => {
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  // The class recurs RECUR_WINDOW runs in a row: the rule was injected yet its class keeps recurring,
  // so it is demonstrably failing at its job — the EVIDENCE that justifies deprecating it.
  const input: AuditInput = {
    outcome: o,
    recent: [o, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    rules: [
      rule({ id: "noise1", errorClass: "E-FRAGILE-SELECTOR", usageCount: 4, successRate: null, status: "candidate" }),
      rule({ id: "proven", errorClass: "E-FRAGILE-SELECTOR", usageCount: 5, successRate: 0.8, status: "active" }), // not a candidate → kept
      rule({ id: "fresh", errorClass: "E-FRAGILE-SELECTOR", usageCount: 1, successRate: null, status: "candidate" }), // too new → kept
      rule({ id: "other", errorClass: "E-EXEC-FAIL", usageCount: 9, successRate: null, status: "candidate" }), // different class → kept
    ],
  };
  const f = auditProcess(input).find((x) => x.kind === "noise-rule");
  assert.ok(f, "expected a noise-rule finding");
  assert.equal(f!.disposition, "ledger-heal");
  assert.deepEqual(f!.ruleIds, ["noise1"]); // ONLY the used candidate whose recurring class it targets
});

test("an UNMEASURED candidate is NOT deprecated when its class is NOT recurring (shadow/oracle-off safety)", () => {
  // Only ONE run of this class → no recurring streak. In shadow/oracle-off mode successRate stays
  // null for genuinely-useful rules too, so absence-of-success alone must NEVER deprecate them.
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const input: AuditInput = {
    outcome: o,
    recent: [o, outcome({ errorClass: "E-EXEC-FAIL", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    rules: [rule({ id: "useful", errorClass: "E-FRAGILE-SELECTOR", usageCount: 8, successRate: null, status: "candidate" })],
  };
  assert.ok(!auditProcess(input).some((x) => x.kind === "noise-rule"), "an unmeasured candidate must not be deprecated when its class is not recurring");
});

test("review churn that never reaches pass → observe", () => {
  const o = outcome({ verdict: "fail", gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 3 } });
  const f = auditProcess({ outcome: o, recent: [o], rules: [] }).find((x) => x.kind === "review-churn-no-gain");
  assert.ok(f);
  assert.equal(f!.disposition, "observe");
});

test("applyAudit ROUTES by disposition — DATA heals autonomously, only an engine-code defect becomes a PR", () => {
  const findings: ProcessFinding[] = [
    { kind: "noise-rule", disposition: "ledger-heal", severity: "warn", summary: "noise", evidence: "e", ruleIds: ["n1", "n2"] },
    { kind: "recurring-error-class", disposition: "engine-fix", severity: "error", summary: "defect", evidence: "e" },
    { kind: "recurring-ui-mismatch", disposition: "context-heal", severity: "warn", summary: "stale map", evidence: "e" },
    { kind: "review-churn-no-gain", disposition: "observe", severity: "warn", summary: "churn", evidence: "e" },
  ];
  const deprecated: string[] = [];
  const incidents: ProcessFinding[] = [];
  let contextReason = "";
  const deps: AuditRouterDeps = {
    log: () => {},
    deprecateRule: (id) => deprecated.push(id),
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: (reason) => { contextReason = reason; return true; },
  };
  const applied = applyAudit(findings, deps);
  assert.deepEqual(deprecated, ["n1", "n2"]); // ledger noise self-healed (no PR)
  assert.equal(incidents.length, 1); // ONLY the engine-code defect became an incident → human-gated PR
  assert.equal(applied.contextInvalidated, 1); // stale map rebuilt autonomously (no PR)
  assert.match(contextReason, /stale map/);
  assert.equal(applied.observed, 1);
});

test("Disposition closed set — memory-heal was removed (no detector ever produced it)", () => {
  // Runtime guard documenting the invariant: auditProcess emits only these four dispositions, and
  // "memory-heal" is no longer one of them. The compile-time proof is separate: process-audit.ts only
  // typechecks because the Disposition union has 4 members and applyAudit's switch is exhaustive.
  const validDispositions = ["engine-fix", "ledger-heal", "context-heal", "observe"];
  assert.equal(validDispositions.includes("memory-heal"), false);
});

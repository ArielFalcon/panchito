// qa-engine/test/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.test.ts
// sdd/migration-remediation Slice 5 (P1 process-audit reconnect, D-P1b): ProcessAuditPortAdapter
// self-sources `recent` outcomes + `rules` via factory-injected reads, runs the deterministic
// auditProcess/applyAudit domain logic, and dispatches findings to 3 injected sinks
// (recordEngineIncident/deprecateRule/invalidateContext). Every failure mode (a throwing read/sink,
// a slow read past the timeout budget) is caught inline — never re-thrown — mirroring
// ReflectorPortAdapter's own documented fault-isolation contract on the sibling port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessAuditPortAdapter, PROCESS_AUDIT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts";
import type { ProcessFinding, RuleView } from "@contexts/cross-run-learning/domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: over.runId ?? "r1",
    app: "petclinic",
    sha: over.sha ?? "abc1234def",
    mode: "manual",
    target: "e2e",
    verdict: over.verdict ?? "fail",
    errorClass: over.errorClass ?? "E-EXEC-FAIL",
    gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...over.gateSignals },
    rulesRetrieved: [],
    at: over.at ?? "2026-06-13T00:00:00Z",
  };
}

const rule = (over: Partial<RuleView>): RuleView => ({ id: "ru1", errorClass: "E-EXEC-FAIL", status: "candidate", usageCount: 0, successRate: null, ...over });

test("engine-fix finding calls recordEngineIncident, and the run verdict is unaffected (nothing thrown)", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("ledger-heal finding deprecates the rule(s), no incident/context call", async () => {
  const current = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const deprecated: Array<{ id: string; reason: string }> = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    readRules: () => [rule({ id: "noise1", errorClass: "E-FRAGILE-SELECTOR", usageCount: 4, status: "candidate" })],
    deprecateRule: (id, reason) => deprecated.push({ id, reason }),
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(deprecated.length, 1);
  assert.equal(deprecated[0]!.id, "noise1");
  assert.match(deprecated[0]!.reason, /noise-rule/);
});

test("context-heal finding invalidates the architecture map, no incident/deprecate call", async () => {
  const current = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  let invalidatedReason: string | undefined;
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: (reason) => { invalidatedReason = reason; return true; },
  });

  await adapter.audit(current);

  assert.ok(invalidatedReason);
  assert.match(invalidatedReason!, /recurring-ui-mismatch/);
});

test("observe finding calls no sink at all", async () => {
  const current = outcome({ verdict: "fail", gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 3 } });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("no findings at all → no sink call, resolves cleanly", async () => {
  const current = outcome({ verdict: "pass", errorClass: null });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("two-layer gating: flaky/infra-class outcomes are excluded from the recent-outcomes streak input before reaching auditProcess", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  // Raw feed: current + a FLAKY entry with a DIFFERENT errorClass wedged in the window + 2 more
  // E-STATIC entries. Unfiltered, slice(0,3) = [E-STATIC, E-FLAKY, E-STATIC] never matches (breaks
  // the streak) — the recurring-error-class finding would NOT fire. Filtered (excluding the flaky
  // entry), the streak becomes 3 consecutive E-STATIC entries and the finding DOES fire — proving
  // the adapter filters before calling into auditProcess, not merely inside the domain function.
  const rawRecent: RunOutcome[] = [
    current,
    outcome({ verdict: "flaky", errorClass: "E-FLAKY", sha: "noise" }),
    outcome({ errorClass: "E-STATIC", sha: "b" }),
    outcome({ errorClass: "E-STATIC", sha: "c" }),
  ];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => rawRecent,
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(incidents.length, 1, "the flaky-noise entry must be excluded from the streak so the real 3-in-a-row is recognized");
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("two-layer gating: an E-INFRA recent entry is also excluded from the streak input", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  const rawRecent: RunOutcome[] = [
    current,
    outcome({ verdict: "infra-error", errorClass: "E-INFRA", sha: "noise" }),
    outcome({ errorClass: "E-STATIC", sha: "b" }),
    outcome({ errorClass: "E-STATIC", sha: "c" }),
  ];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => rawRecent,
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("fault isolation: a throwing readRecentOutcomes is caught, never rethrown, onAuditError is called", async () => {
  let reportedError: unknown;
  const current = outcome();
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => { throw new Error("db exploded"); },
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => {},
    invalidateContext: () => true,
    onAuditError: (e) => { reportedError = e; },
  });

  await assert.doesNotReject(() => adapter.audit(current));
  assert.ok(reportedError instanceof Error);
  assert.match((reportedError as Error).message, /db exploded/);
});

test("fault isolation: a throwing sink is caught, never rethrown", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => { throw new Error("maintainer sink exploded"); },
    invalidateContext: () => true,
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("timeout-capped: a hanging read never blocks audit() past the configured timeout, and is logged", async () => {
  const current = outcome();
  const lines: string[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => new Promise<RunOutcome[]>(() => {}), // never resolves
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => {},
    invalidateContext: () => true,
    timeoutMs: 20,
    log: (line) => lines.push(line),
  });

  const start = Date.now();
  await assert.doesNotReject(() => adapter.audit(current));
  assert.ok(Date.now() - start < 2_000, "audit() must resolve near the configured timeoutMs, not hang");
  assert.ok(lines.some((l) => l.includes("timed out")));
});

test("PROCESS_AUDIT_TIMEOUT_MS default is exported and positive", () => {
  assert.ok(PROCESS_AUDIT_TIMEOUT_MS > 0);
});

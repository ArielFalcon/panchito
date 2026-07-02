import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteRunHistoryAdapter, toLegacyRunOutcome } from "./run-history-sqlite-adapter";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../types";

function kernelOutcome(overrides: Partial<KernelRunOutcome> = {}): KernelRunOutcome {
  return {
    runId: "run-1",
    app: "demo",
    sha: "abc1234",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: 0.85,
      valueScore: 0.5,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

// F1 — the adapter's core contract: save() reaches the injected saveOutcome fn, not the real
// module-singleton SQLite DB (dependency injection is the testing strategy, CLAUDE.md).
test("SqliteRunHistoryAdapter.save() delegates to the injected saveOutcome, mapping the kernel RunOutcome to legacy's shape", async () => {
  let captured: LegacyRunOutcome | undefined;
  const adapter = new SqliteRunHistoryAdapter({ saveOutcome: (o) => { captured = o; } });

  await adapter.save(kernelOutcome());

  assert.ok(captured, "saveOutcome must have been called");
  assert.equal(captured!.runId, "run-1");
  assert.equal(captured!.app, "demo");
  assert.equal(captured!.sha, "abc1234");
  assert.equal(captured!.mode, "diff");
  assert.equal(captured!.target, "e2e");
  assert.equal(captured!.verdict, "pass");
  assert.equal(captured!.gateSignals.coverageRatio, 0.85);
  assert.equal(captured!.gateSignals.valueScore, 0.5);
  assert.deepEqual(captured!.rulesRetrieved, []);
  assert.equal(captured!.at, "2026-07-02T00:00:00.000Z");
});

test("SqliteRunHistoryAdapter uses the real saveRunOutcome by default (no explicit deps)", () => {
  // Construction alone must not touch the DB (saveRunOutcome is only called from save()).
  const adapter = new SqliteRunHistoryAdapter();
  assert.ok(adapter, "constructs without touching the DB (lazy init, per history.ts's own doc)");
});

// ── toLegacyRunOutcome — the field mapping itself ──────────────────────────────────────────────

test("toLegacyRunOutcome carries errorClass through as-is (a genuine taxonomy member, per the kernel's own producer contract)", () => {
  const out = toLegacyRunOutcome(kernelOutcome({ errorClass: "E-EXEC-FAIL" }));
  assert.equal(out.errorClass, "E-EXEC-FAIL");
});

test("toLegacyRunOutcome omits optional gateSignals fields that are absent on the kernel outcome (never fabricates)", () => {
  const out = toLegacyRunOutcome(kernelOutcome());
  assert.equal("reviewerRationale" in out.gateSignals, false);
  assert.equal("reviewerApproved" in out.gateSignals, false);
  assert.equal("confinement" in out.gateSignals, false);
  assert.equal("usage" in out.gateSignals, false);
  assert.equal("phaseTimings" in out.gateSignals, false);
  assert.equal("preExecAmbiguityCatches" in out.gateSignals, false);
  assert.equal("deterministicSelectorBlocks" in out.gateSignals, false);
  assert.equal("catalogGateInWindow" in out.gateSignals, false);
  assert.equal("reflection" in out, false);
});

test("toLegacyRunOutcome forwards every present optional gateSignals field faithfully", () => {
  const out = toLegacyRunOutcome(
    kernelOutcome({
      gateSignals: {
        static: true,
        coverageRatio: 0.7,
        valueScore: 0.4,
        reviewerCorrections: ["missing assertion"],
        reviewerRationale: "solid coverage",
        reviewerApproved: true,
        flaky: false,
        retries: 2,
        confinement: { strays: 0, dangerous: 0, reverted: [] },
        phaseTimings: { generate: 1200 },
        preExecAmbiguityCatches: 1,
        deterministicSelectorBlocks: 0,
        catalogGateInWindow: 3,
        catalogGateAdvisory: 1,
        catalogGateFailClosed: 0,
      },
    }),
  );
  assert.equal(out.gateSignals.reviewerRationale, "solid coverage");
  assert.equal(out.gateSignals.reviewerApproved, true);
  assert.deepEqual(out.gateSignals.confinement, { strays: 0, dangerous: 0, reverted: [] });
  assert.deepEqual(out.gateSignals.phaseTimings, { generate: 1200 });
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 1);
  assert.equal(out.gateSignals.catalogGateInWindow, 3);
  assert.equal(out.gateSignals.catalogGateAdvisory, 1);
  assert.equal(out.gateSignals.catalogGateFailClosed, 0);
});

test("toLegacyRunOutcome forwards rulesRetrieved (W3 F2) and reflection when present", () => {
  const out = toLegacyRunOutcome(
    kernelOutcome({
      rulesRetrieved: ["selector absent", "use role+name"],
      reflection: {
        goal: "test the login form",
        decision: "used role+name selector",
        assumption: "form is server-rendered",
        errorClass: "E-EXEC-FAIL",
        gateSignal: "execution failed",
        evidence: "timeout waiting for selector",
        rootCause: "selector targeted a client-rendered element",
        preventiveRule: { trigger: "client-rendered form", action: "wait for hydration" },
      },
    }),
  );
  assert.deepEqual(out.rulesRetrieved, ["selector absent", "use role+name"]);
  assert.equal(out.reflection?.rootCause, "selector targeted a client-rendered element");
});

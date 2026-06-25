// qa-engine/test/shared-kernel/run-outcome.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../../../src/types.ts";
import { runOutcomeEquivalent, type ComparableOutcome } from "../characterization/equivalence.ts";

// Structural-compatibility pin (legacy → kernel only): a legacy RunOutcome must be assignable TO the
// kernel shape. The kernel fields are intentionally WIDE (errorClass: string | null, usage?: unknown,
// reflection?: unknown) so any legacy value satisfies the kernel type. The reverse (kernel → legacy)
// is NOT required: the kernel is a supertype, not an isomorphic copy, and the Plan-1 comparator works
// on a behavioral projection (ComparableOutcome) that does not read usage/reflection — so wide kernel
// types are fine. This test pins the direction that matters: legacy → kernel.
test("kernel RunOutcome is structurally assignable FROM legacy RunOutcome (legacy → kernel)", () => {
  const kernel: KernelRunOutcome = {
    runId: "r1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.8, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
  };
  const asLegacy: LegacyRunOutcome = kernel as unknown as LegacyRunOutcome; // narrowing (legacy is a subtype of kernel)
  const asKernel: KernelRunOutcome = asLegacy; // legacy → kernel: legacy is a structural subtype, always assignable
  assert.equal(asKernel.verdict, "pass");

  // and the Plan-1 comparator accepts it
  const comparable: ComparableOutcome = { ...kernel };
  assert.equal(runOutcomeEquivalent(comparable, comparable).equal, true);
});

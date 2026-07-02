// test/contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.test.ts
// RED-first (Task E.0): ObjectiveSignalPortAdapter composes the REAL keystone collaborators —
// CoverageCollectorPort.collect (raw covered lines), DecideCoverageService.decide (the keystone:
// unknown NEVER blocks — consumed VERBATIM, never reimplemented) and ValueOraclePort.measure (the
// mutation-testing / fault-injection valueScore). THIN — no new coverage-ratio logic added here.
//
// PLAN DRIFT (recorded per Task E.0's own instruction): there is NO assembly function under
// objective-signal/ that turns CoverageCollectorPort's raw CoverageReport + a diff into the
// ChangeCoverage read-model DecideCoverageService.decide() actually consumes (the legacy's
// computeChangeCoverage + parseDiffHunks in src/qa/change-coverage.ts have NOT been ported to
// qa-engine yet — grep-confirmed zero occurrences under objective-signal/). This bridge accepts an
// OPTIONAL injected ChangeCoverageAssembler; absent -> decide() correctly receives null ->
// "unknown" -> NEVER blocks (architecturally safe per the keystone invariant, not a workaround).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectiveSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.ts";
import { DecideCoverageService, type ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, ValueOraclePort, CoverageReport, ValueOracleResult } from "@contexts/objective-signal/application/ports/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

function fakeCollector(report: CoverageReport): CoverageCollectorPort {
  return { collect: async () => report };
}
function fakeOracle(result: ValueOracleResult): ValueOraclePort {
  return { measure: async () => result };
}

test("measure() returns unknown+null when no ChangeCoverage assembler is injected (keystone-safe default)", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2, 3] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.status, "unknown");
  assert.equal(result.ratio, null);
});

test("measure() delegates to the injected ChangeCoverageAssembler + DecideCoverageService.decide verbatim", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const assembleChangeCoverage = (): ChangeCoverage => ({
    measured: true,
    overall: { changedLines: 2, coveredChanged: 2, ratio: 1 },
    perFile: [],
    uncovered: [],
    branches: null,
  });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.status, "pass");
  assert.equal(result.ratio, 1);
});

test("measure() surfaces valueScore from the injected ValueOraclePort (the mutation-testing keystone companion)", async () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: 0.85, mutantCount: 20, killedCount: 17, details: "17/20 mutants killed" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.valueScore, 0.85);
});

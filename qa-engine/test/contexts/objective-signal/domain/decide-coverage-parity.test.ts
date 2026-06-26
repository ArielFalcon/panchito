// test/contexts/objective-signal/domain/decide-coverage-parity.test.ts
// PARITY: the keystone gate must match src/qa/change-coverage.ts byte-for-byte (risk R2 pin).
// Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
//
// Three families of unknown-producing inputs are parity-pinned (src/qa/change-coverage.ts:174
// `!cc || !cc.measured || changedLines===0`):
//   1. null input
//   2. cc.measured === false
//   3. cc.overall.changedLines === 0
// For each, both decide() and blocks("unknown") are compared against the legacy originals across
// all three modes (off/signal/enforce). A gutted implementation that blocks on "unknown" or
// returns a non-unknown status for unmeasured inputs will fail these assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { decideCoverage, blocksPublish } from "../../../../../src/qa/change-coverage.ts";

const svc = new DecideCoverageService();
test("PARITY: decide()/blocks() match legacy across the policy×ratio matrix", () => {
  const modes = ["off", "signal", "enforce"] as const;
  const ratios = [0, 0.5, 0.69, 0.7, 0.71, 1];
  for (const mode of modes) {
    const policy = { mode, minRatio: 0.7 };
    for (const ratio of ratios) {
      const cc = { measured: true, overall: { changedLines: 10, coveredChanged: Math.round(10 * ratio), ratio }, perFile: [], uncovered: [], branches: null };
      const status = svc.decide(cc, policy);
      assert.equal(status, decideCoverage(cc as never, policy as never), `${mode}/${ratio}`);
      assert.equal(svc.blocks(status, policy), blocksPublish(status, policy as never), `${mode}/${ratio} blocks`);
    }

    // --- unknown-producing inputs: all three legacy guard branches (change-coverage.ts:174) ---

    // Branch 1: null input → unknown, never blocks
    const nullStatus = svc.decide(null, policy);
    assert.equal(nullStatus, decideCoverage(null, policy as never), `${mode}/null decide`);
    assert.equal(svc.blocks(nullStatus, policy), blocksPublish(nullStatus, policy as never), `${mode}/unknown blocks`);

    // Branch 2: measured:false → unknown, never blocks
    const unmeasuredCc = { measured: false, overall: { changedLines: 10, coveredChanged: 5, ratio: 0.5 }, perFile: [], uncovered: [], branches: null };
    const unmeasuredStatus = svc.decide(unmeasuredCc, policy);
    assert.equal(unmeasuredStatus, decideCoverage(unmeasuredCc as never, policy as never), `${mode}/measured:false decide`);
    assert.equal(svc.blocks(unmeasuredStatus, policy), blocksPublish(unmeasuredStatus, policy as never), `${mode}/measured:false blocks`);

    // Branch 3: changedLines:0 → unknown, never blocks
    const zeroLinesCc = { measured: true, overall: { changedLines: 0, coveredChanged: 0, ratio: 1 }, perFile: [], uncovered: [], branches: null };
    const zeroLinesStatus = svc.decide(zeroLinesCc, policy);
    assert.equal(zeroLinesStatus, decideCoverage(zeroLinesCc as never, policy as never), `${mode}/changedLines:0 decide`);
    assert.equal(svc.blocks(zeroLinesStatus, policy), blocksPublish(zeroLinesStatus, policy as never), `${mode}/changedLines:0 blocks`);
  }
});

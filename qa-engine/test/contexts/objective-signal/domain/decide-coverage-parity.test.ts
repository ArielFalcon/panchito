// test/contexts/objective-signal/domain/decide-coverage-parity.test.ts
// PARITY: the keystone gate must match src/qa/change-coverage.ts byte-for-byte (risk R2 pin).
// Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
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
    // null + unmeasured branches
    assert.equal(svc.decide(null, policy), decideCoverage(null, policy as never));
  }
});

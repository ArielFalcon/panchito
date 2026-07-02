import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the re-ported progress-gate helpers (Task D.4's dependency) must match src/qa/
// progress-gate.ts across the same domain test-execution's OWN parity-pinned copy already covers,
// but pinned independently — qa-run-orchestration must not import test-execution's domain, so this
// is a SEPARATE re-port, not a re-use of that copy. This file imports src/qa/progress-gate.ts, so it
// is added to the qa-engine typecheck "exclude" list (same parity-import pattern as
// derive-cycle-backstop-parity.test.ts).
import {
  classifyFailure,
  bestRound,
  decideProgress,
  isLikelyRealBug,
  type RoundResult,
} from "@contexts/qa-run-orchestration/domain/helpers/progress-gate.ts";
import {
  classifyFailure as legacyClassifyFailure,
  bestRound as legacyBestRound,
  decideProgress as legacyDecideProgress,
  isLikelyRealBug as legacyIsLikelyRealBug,
} from "../../../../../../src/qa/progress-gate.ts";

test("PARITY: classifyFailure matches legacy across value-mismatch/timeout/locator/other samples", () => {
  const samples = [
    "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'",
    "expect(locator).toBeVisible() failed\nExpected: visible\nReceived: <element(s) not found>",
    "Timeout 30000ms exceeded while waiting for locator",
    "getByRole('button', { name: 'Submit' }) resolved to 0 elements",
    "some totally ambiguous free-text failure",
    "",
  ];
  for (const s of samples) {
    assert.equal(classifyFailure(s), legacyClassifyFailure(s), `sample: ${JSON.stringify(s)}`);
  }
});

test("PARITY: bestRound matches legacy — fewest failures, ties prefer later", () => {
  const rounds = [{ failingCount: 3 }, { failingCount: 1 }, { failingCount: 1 }];
  assert.deepEqual(bestRound(rounds), legacyBestRound(rounds));
});

test("PARITY: decideProgress matches legacy — first retry (prev=null) always spends", () => {
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(null, cur), legacyDecideProgress(null, cur));
});

test("PARITY: decideProgress matches legacy — regression (more failures) stops", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a", "b"]), failingCount: 2, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: decideProgress matches legacy — signal A (fewer failures) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a", "b"]), failingCount: 2, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: decideProgress matches legacy — signal B (name set changed) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["b"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: decideProgress matches legacy — signal B downgraded by reexplore thrash", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["b"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0, reexploreNavigations: 3 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: decideProgress matches legacy — signal C (lever2 flip) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(["role:name"]), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 1 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: decideProgress matches legacy — fail-closed (no signal) stops", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), legacyDecideProgress(prev, cur));
});

test("PARITY: isLikelyRealBug matches legacy — true case (unique + all value-mismatch)", () => {
  const details = ["expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'"];
  assert.equal(isLikelyRealBug(true, details), legacyIsLikelyRealBug(true, details));
});

test("PARITY: isLikelyRealBug matches legacy — false case (not unique)", () => {
  const details = ["expect(locator).toHaveText(expected) failed"];
  assert.equal(isLikelyRealBug(false, details), legacyIsLikelyRealBug(false, details));
});

test("PARITY: isLikelyRealBug matches legacy — false case (empty details)", () => {
  assert.equal(isLikelyRealBug(true, []), legacyIsLikelyRealBug(true, []));
});

test("PARITY: isLikelyRealBug matches legacy — false case (mixed classes)", () => {
  const details = ["expect(locator).toHaveText(expected) failed", "getByRole resolved to 0 elements"];
  assert.equal(isLikelyRealBug(true, details), legacyIsLikelyRealBug(true, details));
});

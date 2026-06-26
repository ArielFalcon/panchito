// PARITY vs src/qa/progress-gate.ts (HEAD). Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProgressGateService,
  classifyFailure,
  decideProgress,
  isLikelyRealBug,
  bestRound,
  type RoundResult,
} from "@contexts/test-execution/domain/progress-gate.service.ts";
import {
  classifyFailure as legacyClassifyFailure,
  decideProgress as legacyDecideProgress,
  isLikelyRealBug as legacyIsLikelyRealBug,
  bestRound as legacyBestRound,
} from "../../../../../src/qa/progress-gate.ts";

const svc = new ProgressGateService();

const round = (failingCount: number, names: string[], lever2Flips = 0, reexploreNavigations?: number): RoundResult => ({
  failingNames: new Set(names),
  failingCount,
  absentSelectors: new Set(),
  lever2Flips,
  ...(reexploreNavigations !== undefined ? { reexploreNavigations } : {}),
});

const details = [
  "",
  "element(s) not found",
  "Expected: foo\nReceived: bar",
  "Timeout 30000ms exceeded",
  "strict mode violation",
  "getByRole(...) resolved to 2 elements",
  ".toHaveText() failed",
  ".toBeVisible() expected to be visible",
  "expect(x).toBe(y) failed",
  "Expected: visible\nReceived: <element(s) not found>",
  "Target page, context or browser has been closed",
  "waiting for locator(\"button\")",
  "to equal",
  "assertion failed",
];

test("PARITY: classifyFailure matches legacy across sample details", () => {
  for (const d of details) {
    assert.equal(classifyFailure(d), legacyClassifyFailure(d), JSON.stringify(d));
  }
});

test("PARITY: decideProgress matches legacy across sample round pairs", () => {
  const pairs: Array<[RoundResult | null, RoundResult]> = [
    [null, round(2, ["a", "b"])],
    [round(3, ["a", "b", "c"]), round(2, ["a", "b"])],
    [round(1, ["a"]), round(2, ["a", "b"])],
    [round(2, ["a", "b"]), round(2, ["b", "c"])],
    [round(2, ["a", "b"]), round(2, ["b", "c"], 0, 3)],
    [round(2, ["a", "b"]), round(2, ["a", "b"], 1)],
    [round(2, ["a", "b"]), round(2, ["a", "b"], 0)],
  ];
  for (const [prev, cur] of pairs) {
    const svcResult = svc.decideProgress(prev, cur);
    const legacyResult = legacyDecideProgress(prev, cur);
    assert.equal(svcResult.spend, legacyResult.spend, JSON.stringify({ prev, cur }));
    assert.equal(svcResult.reason, legacyResult.reason, JSON.stringify({ prev, cur }));
  }
});

test("PARITY: isLikelyRealBug matches legacy", () => {
  const samples: Array<[boolean, string[]]> = [
    [true, ["Expected: foo\nReceived: bar"]],
    [false, ["Expected: foo\nReceived: bar"]],
    [true, ["element(s) not found"]],
    [true, []],
    [true, ["Expected: foo\nReceived: bar", "element(s) not found"]],
  ];
  for (const [allUnique, failDetails] of samples) {
    assert.equal(
      svc.isLikelyRealBug(allUnique, failDetails),
      legacyIsLikelyRealBug(allUnique, failDetails),
      JSON.stringify({ allUnique, failDetails }),
    );
  }
});

test("PARITY: bestRound matches legacy", () => {
  const samples = [
    [],
    [round(1, ["a"])],
    [round(3, ["a", "b", "c"]), round(1, ["a"]), round(2, ["a", "b"])],
    [round(2, ["a", "b"]), round(2, ["c", "d"])],
  ];
  for (const rounds of samples) {
    const svcResult = svc.bestRound(rounds);
    const legacyResult = legacyBestRound(rounds);
    assert.deepEqual(svcResult, legacyResult, JSON.stringify(rounds));
  }
});

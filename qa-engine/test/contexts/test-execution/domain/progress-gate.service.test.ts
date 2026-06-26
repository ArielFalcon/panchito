import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressGateService, type RoundResult } from "@contexts/test-execution/domain/progress-gate.service.ts";

const svc = new ProgressGateService();

const round = (failingCount: number, names: string[], lever2Flips = 0, reexploreNavigations?: number): RoundResult => ({
  failingNames: new Set(names),
  failingCount,
  absentSelectors: new Set(),
  lever2Flips,
  ...(reexploreNavigations !== undefined ? { reexploreNavigations } : {}),
});

test("first retry is always allowed (prev === null)", () => {
  const d = svc.decideProgress(null, round(2, ["a", "b"]));
  assert.equal(d.spend, true);
  assert.match(d.reason, /first retry/);
});

test("signal A: failing count decreased → spend", () => {
  const d = svc.decideProgress(round(3, ["a", "b", "c"]), round(2, ["a", "b"]));
  assert.equal(d.spend, true);
  assert.match(d.reason, /progress \(A\)/);
});

test("regression: failing count increased → stop", () => {
  const d = svc.decideProgress(round(1, ["a"]), round(2, ["a", "b"]));
  assert.equal(d.spend, false);
  assert.match(d.reason, /regression/);
});

test("signal B: failing names set changed → spend", () => {
  const d = svc.decideProgress(round(2, ["a", "b"]), round(2, ["b", "c"]));
  assert.equal(d.spend, true);
  assert.match(d.reason, /progress \(B\)/);
});

test("signal B with heavy re-exploration → no progress (stop)", () => {
  const d = svc.decideProgress(round(2, ["a", "b"]), round(2, ["b", "c"], 0, 3));
  assert.equal(d.spend, false);
  assert.match(d.reason, /reshuffled/);
});

test("signal C: lever2Flips > 0 → spend", () => {
  const d = svc.decideProgress(round(2, ["a", "b"]), round(2, ["a", "b"], 1));
  assert.equal(d.spend, true);
  assert.match(d.reason, /progress \(C\)/);
});

test("no signal: identical count + identical names + no flips → stop", () => {
  const d = svc.decideProgress(round(2, ["a", "b"]), round(2, ["a", "b"], 0));
  assert.equal(d.spend, false);
  assert.match(d.reason, /no progress/);
});

test("isLikelyRealBug: all unique + all value-mismatch → true", () => {
  assert.equal(svc.isLikelyRealBug(true, ["Expected: foo\nReceived: bar"]), true);
});

test("isLikelyRealBug: not all unique → false", () => {
  assert.equal(svc.isLikelyRealBug(false, ["Expected: foo\nReceived: bar"]), false);
});

test("isLikelyRealBug: locator error is not a real bug", () => {
  assert.equal(svc.isLikelyRealBug(true, ["element(s) not found"]), false);
});

test("bestRound: returns round with fewest failures", () => {
  const rounds = [round(3, ["a", "b", "c"]), round(1, ["a"]), round(2, ["a", "b"])];
  const best = svc.bestRound(rounds);
  assert.equal(best?.failingCount, 1);
});

test("bestRound: empty array returns undefined", () => {
  assert.equal(svc.bestRound([]), undefined);
});

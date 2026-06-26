// test/contexts/objective-signal/domain/decide-coverage.service.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DecideCoverageService,
  type ChangeCoverage,
  type CoveragePolicy,
} from "@contexts/objective-signal/domain/decide-coverage.service.ts";

const svc = new DecideCoverageService();
const cc = (ratio: number, changedLines = 10, measured = true): ChangeCoverage =>
  ({ measured, overall: { changedLines, coveredChanged: Math.round(changedLines * ratio), ratio }, perFile: [], uncovered: [], branches: null });
const enforce: CoveragePolicy = { mode: "enforce", minRatio: 0.7 };
const signal: CoveragePolicy = { mode: "signal", minRatio: 0.7 };

test("unmeasured coverage is unknown and NEVER blocks (the keystone invariant)", () => {
  assert.equal(svc.decide(null, enforce), "unknown");
  assert.equal(svc.decide(cc(0, 10, false), enforce), "unknown");
  assert.equal(svc.blocks("unknown", enforce), false);
});

test("zero changed lines is unknown", () => {
  assert.equal(svc.decide(cc(0, 0), enforce), "unknown");
});

test("ratio at/above minRatio passes; below fails", () => {
  assert.equal(svc.decide(cc(0.7), enforce), "pass");
  assert.equal(svc.decide(cc(0.69), enforce), "fail");
});

test("signal mode never blocks even on a fail", () => {
  assert.equal(svc.decide(cc(0.1), signal), "fail");
  assert.equal(svc.blocks("fail", signal), false);
});

test("enforce blocks ONLY on a measured fail", () => {
  assert.equal(svc.blocks("fail", enforce), true);
  assert.equal(svc.blocks("pass", enforce), false);
  assert.equal(svc.blocks("unknown", enforce), false);
});

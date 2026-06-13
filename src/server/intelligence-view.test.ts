import { test } from "node:test";
import assert from "node:assert/strict";
import { toIntelligenceView } from "./intelligence-view";

test("toIntelligenceView projects rules, scorecard and curriculum", () => {
  const rules = [
    {
      id: "r1", trigger: "fragile selector", action: "scope to a test id",
      errorClass: "E-SELECTOR-FRAGILE", confidence: "high",
      usageCount: 22, outcomeCount: 3, successRate: 0.86,
      lastVerified: null, source: "reviewer", status: "active", at: "2026-01-01",
    },
  ] as never;
  const scorecard = {
    app: "panchito", updatedAt: "2026-01-02",
    entries: [
      { runId: "x", app: "panchito", sha: "s", target: "code", valueScore: 0.82, mutantCount: 50, killedCount: 41, at: "2026-01-02" },
    ],
    summary: { totalRuns: 1, measuredRuns: 1, avgValueScore: 0.82, lastValueScore: 0.82 },
  } as never;
  const curriculum = {
    app: "panchito", updatedAt: "2026-01-02",
    archetypes: [
      { archetype: "happy-path", caughtRealBug: true, firstCaughtAt: "2026-01-01", promotionCount: 2, lastPromoted: "2026-01-02" },
    ],
  } as never;

  const view = toIntelligenceView("panchito", rules, scorecard, curriculum);
  assert.equal(view.app, "panchito");
  assert.equal(view.rules.length, 1);
  assert.equal(view.rules[0]!.confidence, "high");
  assert.equal(view.rules[0]!.successRate, 0.86);
  assert.equal(view.scorecard?.lastValueScore, 0.82);
  assert.equal(view.scorecard?.entries[0]!.killedCount, 41);
  assert.equal(view.curriculum?.archetypes[0]!.caughtRealBug, true);
});

test("toIntelligenceView tolerates a missing scorecard and curriculum", () => {
  const view = toIntelligenceView("portfolio", [], null, null);
  assert.equal(view.scorecard, null);
  assert.equal(view.curriculum, null);
  assert.deepEqual(view.rules, []);
});

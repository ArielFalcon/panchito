import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updateScorecard, type Scorecard, type ScorecardEntry } from "./oracle-types";

function entry(overrides: Partial<ScorecardEntry> = {}): ScorecardEntry {
  return {
    runId: "run-1",
    app: "test-app",
    sha: "abc123",
    target: "code",
    valueScore: null,
    mutantCount: 0,
    killedCount: 0,
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("updateScorecard", () => {
  it("creates a new scorecard from null with one entry", () => {
    const e = entry({ valueScore: 0.75, mutantCount: 100, killedCount: 75 });
    const s = updateScorecard(null, e);
    assert.equal(s.entries.length, 1);
    assert.equal(s.summary.totalRuns, 1);
    assert.equal(s.summary.measuredRuns, 1);
    assert.equal(s.summary.avgValueScore, 0.75);
    assert.equal(s.summary.lastValueScore, 0.75);
  });

  it("appends to existing scorecard", () => {
    const e1 = entry({ runId: "run-1", valueScore: 0.6, mutantCount: 100, killedCount: 60 });
    const e2 = entry({ runId: "run-2", valueScore: 0.8, mutantCount: 50, killedCount: 40 });
    const s1 = updateScorecard(null, e1);
    const s2 = updateScorecard(s1, e2);

    assert.equal(s2.entries.length, 2);
    assert.equal(s2.summary.totalRuns, 2);
    assert.equal(s2.summary.measuredRuns, 2);
    assert.equal(s2.summary.avgValueScore, 0.7);
    assert.equal(s2.summary.lastValueScore, 0.8);
  });

  it("handles null valueScore entries (unmeasured runs)", () => {
    const e1 = entry({ runId: "run-1", valueScore: null });
    const e2 = entry({ runId: "run-2", valueScore: 0.9, mutantCount: 10, killedCount: 9 });
    const s1 = updateScorecard(null, e1);
    const s2 = updateScorecard(s1, e2);

    assert.equal(s2.summary.totalRuns, 2);
    assert.equal(s2.summary.measuredRuns, 1);
    assert.equal(s2.summary.avgValueScore, 0.9);
    assert.equal(s2.summary.lastValueScore, 0.9);
  });

  it("all null valueScores → avgValueScore and lastValueScore are null", () => {
    const e1 = entry({ runId: "run-1", valueScore: null });
    const e2 = entry({ runId: "run-2", valueScore: null });
    const s = updateScorecard(updateScorecard(null, e1), e2);

    assert.equal(s.summary.measuredRuns, 0);
    assert.equal(s.summary.avgValueScore, null);
    assert.equal(s.summary.lastValueScore, null);
  });

  it("preserves entry order", () => {
    const e1 = entry({ runId: "run-a", valueScore: 0.5, mutantCount: 10, killedCount: 5 });
    const e2 = entry({ runId: "run-b", valueScore: 0.7, mutantCount: 10, killedCount: 7 });
    const e3 = entry({ runId: "run-c", valueScore: 0.9, mutantCount: 10, killedCount: 9 });
    const s = updateScorecard(updateScorecard(updateScorecard(null, e1), e2), e3);

    assert.equal(s.entries[0]!.runId, "run-a");
    assert.equal(s.entries[1]!.runId, "run-b");
    assert.equal(s.entries[2]!.runId, "run-c");
  });
});

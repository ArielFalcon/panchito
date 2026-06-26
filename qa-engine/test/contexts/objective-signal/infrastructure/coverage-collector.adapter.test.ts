import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageCollectorAdapter } from "@contexts/objective-signal/infrastructure/coverage-collector.adapter.ts";
import type { CoverageCollectorPort, CoverageReport } from "@contexts/objective-signal/application/ports/index.ts";

const empty: CoverageReport = { covered: [] };

function stub(report: CoverageReport): CoverageCollectorPort {
  return { collect: async () => report };
}

test("merges reports from all collectors, deduplicating covered lines by file", async () => {
  const a: CoverageReport = { covered: [{ file: "src/svc.ts", lines: [1, 2] }] };
  const b: CoverageReport = { covered: [{ file: "src/svc.ts", lines: [2, 3] }, { file: "src/util.ts", lines: [5] }] };
  const composite = new CoverageCollectorAdapter([stub(a), stub(b)]);
  const result = await composite.collect("/e2e", "qa-abc");
  const svc = result.covered.find((c) => c.file === "src/svc.ts");
  const util = result.covered.find((c) => c.file === "src/util.ts");
  assert.ok(svc);
  assert.deepEqual([...new Set(svc!.lines)].sort((x, y) => x - y), [1, 2, 3]);
  assert.ok(util);
  assert.deepEqual(util!.lines, [5]);
});

test("returns an empty report when there are no collectors (fail-open)", async () => {
  const composite = new CoverageCollectorAdapter([]);
  const result = await composite.collect("/e2e", "qa-abc");
  assert.deepEqual(result.covered, []);
});

test("a throwing collector degrades to an empty report (fail-open, never throws)", async () => {
  const broken: CoverageCollectorPort = { collect: async () => { throw new Error("broken"); } };
  const working = stub({ covered: [{ file: "src/a.ts", lines: [1] }] });
  const composite = new CoverageCollectorAdapter([broken, working]);
  // Should not throw — the broken collector degrades to empty, working one is used
  const result = await composite.collect("/e2e", "qa-abc");
  assert.ok(result.covered.some((c) => c.file === "src/a.ts"));
});

test("a slow collector times out and returns empty (bounded timeout, fail-open)", async () => {
  const slow: CoverageCollectorPort = {
    collect: () => new Promise(() => { /* never resolves */ }),
  };
  const composite = new CoverageCollectorAdapter([slow], 50); // 50ms timeout
  const result = await composite.collect("/e2e", "qa-abc");
  assert.deepEqual(result.covered, []);
});

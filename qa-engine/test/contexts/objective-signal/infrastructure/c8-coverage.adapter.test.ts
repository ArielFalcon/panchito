import { test } from "node:test";
import assert from "node:assert/strict";
import { C8CoverageAdapter } from "@contexts/objective-signal/infrastructure/c8-coverage.adapter.ts";

// Minimal Istanbul coverage-final.json (c8/nyc format)
const ISTANBUL_JSON = {
  "/repo/src/svc.ts": {
    path: "src/svc.ts",
    statementMap: {
      "0": { start: { line: 1 }, end: { line: 1 } },
      "1": { start: { line: 2 }, end: { line: 2 } },
      "2": { start: { line: 3 }, end: { line: 3 } },
    },
    s: { "0": 5, "1": 0, "2": 3 }, // statement 1 not hit
  },
};

test("parses injected Istanbul JSON into a CoverageReport (only hit statements)", async () => {
  const adapter = new C8CoverageAdapter(
    async () => [{ path: "/repo/coverage/coverage-final.json", json: ISTANBUL_JSON }],
    "/repo",
  );
  const report = await adapter.collect("/repo/e2e", "qa-abc");
  const file = report.covered.find((c) => c.file === "src/svc.ts");
  assert.ok(file, "file must be found");
  // lines 1 and 3 are covered (hit counts > 0); line 2 is not
  assert.ok(file!.lines.includes(1), "line 1 should be covered");
  assert.ok(file!.lines.includes(3), "line 3 should be covered");
  assert.ok(!file!.lines.includes(2), "line 2 should NOT be covered");
});

test("returns an empty report when no Istanbul JSON files found (fail-open)", async () => {
  const adapter = new C8CoverageAdapter(async () => [], "/repo");
  const report = await adapter.collect("/repo/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

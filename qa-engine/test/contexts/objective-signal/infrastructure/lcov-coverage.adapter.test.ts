import { test } from "node:test";
import assert from "node:assert/strict";
import { LcovCoverageAdapter } from "@contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts";

const LCOV = ["SF:src/svc.ts", "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record"].join("\n");

test("parses injected lcov text into a CoverageReport (only hit lines)", async () => {
  const adapter = new LcovCoverageAdapter(
    async () => [{ path: "/m/coverage/lcov.info", text: LCOV }],   // injected file reader
    "/m",
  );
  const report = await adapter.collect("/m/e2e", "qa-abc");
  const file = report.covered.find((c) => c.file === "src/svc.ts");
  assert.ok(file);
  assert.deepEqual(file!.lines.sort((a, b) => a - b), [1, 3]); // line 2 had 0 hits → excluded
});

test("returns an empty report when no lcov files are found (never throws — fail-open)", async () => {
  const adapter = new LcovCoverageAdapter(async () => [], "/m");
  const report = await adapter.collect("/m/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

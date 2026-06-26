import { test } from "node:test";
import assert from "node:assert/strict";
import { V8BrowserCoverageAdapter } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

// Minimal V8 coverage dump.
// source: "export function f() {\n  return 1;\n}\n"
//   line 1 starts at offset 0,  newline at 21
//   line 2 starts at offset 22, newline at 33
//   line 3 starts at offset 34, newline at 35
// Range [0,34) covers lines 1+2 (count=3); range [34,36) covers line 3 (count=0).
const V8_ENTRIES = [
  {
    url: "https://dev/src/svc.ts",
    source: "export function f() {\n  return 1;\n}\n",
    functions: [
      {
        ranges: [
          { startOffset: 0, endOffset: 34, count: 3 },   // lines 1-2 covered
          { startOffset: 34, endOffset: 36, count: 0 },  // line 3 NOT covered
        ],
      },
    ],
  },
];

const CHANGED_FILES = ["src/svc.ts"];

test("parses injected V8 entries into a CoverageReport (covered byte ranges only)", async () => {
  const adapter = new V8BrowserCoverageAdapter(
    async () => [{ path: "/e2e/.qa/coverage/qa-abc/dump.json", entries: V8_ENTRIES }],
    CHANGED_FILES,
  );
  const report = await adapter.collect("/e2e", "qa-abc");
  const file = report.covered.find((c) => c.file === "src/svc.ts");
  assert.ok(file, "file must be found by URL suffix match");
  assert.ok(file!.lines.includes(1), "line 1 should be covered");
  assert.ok(file!.lines.includes(2), "line 2 should be covered");
  assert.ok(!file!.lines.includes(3), "line 3 should NOT be covered (count=0)");
});

test("returns an empty report when no V8 dump files found (fail-open)", async () => {
  const adapter = new V8BrowserCoverageAdapter(async () => [], CHANGED_FILES);
  const report = await adapter.collect("/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

test("returns an empty report when no changed file matches any entry URL (fail-open)", async () => {
  const adapter = new V8BrowserCoverageAdapter(
    async () => [{ path: "/e2e/.qa/coverage/qa-abc/dump.json", entries: V8_ENTRIES }],
    ["other/unrelated.ts"],  // no URL suffix match
  );
  const report = await adapter.collect("/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});

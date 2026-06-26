// test/contexts/objective-signal/infrastructure/v8-browser-coverage-parity.test.ts
// PARITY: defaultParseV8Coverage must match parseV8Coverage from src/qa/change-coverage.ts.
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseV8Coverage } from "../../../../../src/qa/change-coverage.ts";
import { defaultParseV8Coverage } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

const CHANGED_FILES = ["src/svc.ts", "src/util.ts"];

// source: "export function f() {\n  return 1;\n}\n"
//   line 1 starts at offset 0,  newline at 21
//   line 2 starts at offset 22, newline at 33
//   line 3 starts at offset 34, newline at 35
const SOURCE = "export function f() {\n  return 1;\n}\n";

const fixtures = [
  // Simple unbundled URL suffix match — lines 1-2 covered, line 3 not
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [{
        ranges: [
          { startOffset: 0, endOffset: 34, count: 3 },
          { startOffset: 34, endOffset: 36, count: 0 },
        ],
      }],
    }],
    changedFiles: CHANGED_FILES,
    label: "unbundled URL suffix match",
  },
  // URL that matches no changed file → no output
  {
    entries: [{
      url: "https://dev/unrelated.js",
      source: SOURCE,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 36, count: 5 }] }],
    }],
    changedFiles: CHANGED_FILES,
    label: "no URL match",
  },
  // No functions → empty output
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [],
    }],
    changedFiles: CHANGED_FILES,
    label: "no functions",
  },
  // Empty entries
  {
    entries: [],
    changedFiles: CHANGED_FILES,
    label: "empty entries",
  },
  // count=0 for all ranges → nothing covered
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 36, count: 0 }] }],
    }],
    changedFiles: CHANGED_FILES,
    label: "all count=0",
  },
];

test("PARITY: defaultParseV8Coverage matches parseV8Coverage across fixtures", () => {
  for (const { entries, changedFiles, label } of fixtures) {
    // The legacy parseV8Coverage takes V8Entry[] from its internal type; we use `as never`
    // to bridge the structural type since the shape is identical.
    const legacy = parseV8Coverage(entries as never, changedFiles);
    const local = defaultParseV8Coverage(entries as never, changedFiles);
    const toObj = (m: Map<string, Set<number>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
    assert.deepEqual(toObj(local), toObj(legacy), `fixture: ${label}`);
  }
});

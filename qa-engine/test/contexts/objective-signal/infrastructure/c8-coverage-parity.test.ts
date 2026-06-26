// test/contexts/objective-signal/infrastructure/c8-coverage-parity.test.ts
// PARITY: defaultParseIstanbulJson must match parseIstanbulJson from src/qa/change-coverage.ts.
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIstanbulJson } from "../../../../../src/qa/change-coverage.ts";
import { defaultParseIstanbulJson } from "@contexts/objective-signal/infrastructure/c8-coverage.adapter.ts";

const REPO_DIR = "/workspace/myapp";

const ISTANBUL_FIXTURE = {
  "/workspace/myapp/src/a.ts": {
    path: "src/a.ts",
    statementMap: {
      "0": { start: { line: 1 }, end: { line: 1 } },
      "1": { start: { line: 2 }, end: { line: 3 } }, // multi-line statement
      "2": { start: { line: 5 }, end: { line: 5 } },
    },
    s: { "0": 1, "1": 0, "2": 3 },
  },
  "src/b.ts": {
    path: "src/b.ts",
    statementMap: {
      "0": { start: { line: 10 }, end: { line: 10 } },
    },
    s: { "0": 0 }, // zero hits → file should be excluded
  },
};

// Absolute-path else-if fixture: the Istanbul entry uses a double-slash absolute path so the simple
// startsWith(root + "/") check fails ("//workspace/..." does not start with "/workspace/..."). Only
// the else-if (isAbsolute) fallback — path.relative(repoDir, p) → "src/bar.ts" — produces the
// correct repo-relative key. Without it, the adapter strips only the leading slashes via
// replace(/^\/+/, ""), producing "workspace/myapp/src/bar.ts" instead of "src/bar.ts".
const ISTANBUL_DOUBLESLASH_FIXTURE = {
  [`//${REPO_DIR.slice(1)}/src/bar.ts`]: {
    path: `//${REPO_DIR.slice(1)}/src/bar.ts`,
    statementMap: {
      "0": { start: { line: 3 }, end: { line: 3 } },
    },
    s: { "0": 2 },
  },
};

const fixtures: Array<{ json: unknown; repoDir?: string }> = [
  { json: ISTANBUL_FIXTURE, repoDir: REPO_DIR },
  { json: ISTANBUL_FIXTURE },   // no repoDir
  // Pins the else-if (isAbsolute) fallback branch restored in WF-04 + B2-C8-PARITY-FIXTURE-WEAK.
  // A double-slash absolute path fails startsWith(root+"/") but path.relative() resolves it to
  // "src/bar.ts". Without the else-if, the adapter produces "workspace/myapp/src/bar.ts" instead.
  { json: ISTANBUL_DOUBLESLASH_FIXTURE, repoDir: REPO_DIR },
  { json: null },
  { json: {} },
  { json: "not an object" },
];

test("PARITY: defaultParseIstanbulJson matches parseIstanbulJson across fixtures", () => {
  for (const { json, repoDir } of fixtures) {
    const legacy = parseIstanbulJson(json, repoDir);
    const local = defaultParseIstanbulJson(json, repoDir);
    const toObj = (m: Map<string, Set<number>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
    assert.deepEqual(toObj(local), toObj(legacy), `fixture: ${JSON.stringify(json).slice(0, 60)}`);
  }
});

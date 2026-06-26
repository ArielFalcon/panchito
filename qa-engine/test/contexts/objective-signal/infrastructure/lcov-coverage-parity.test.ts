// test/contexts/objective-signal/infrastructure/lcov-coverage-parity.test.ts
// PARITY: defaultParseLcov must match parseLcov from src/qa/change-coverage.ts.
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov } from "../../../../../src/qa/change-coverage.ts";

// Import the private defaultParseLcov via a re-export added to lcov-coverage.adapter.ts
// (export it as a named export for testability — the Plan-6 wiring only uses the class).
import { defaultParseLcov } from "@contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts";

// Two-SF-block fixture: exercises end_of_record reset. Without the reset, block-2 lines
// would be appended to the block-1 file's Set.
const REPO_DIR = "/workspace/myapp";

const TWO_BLOCK_LCOV = [
  "SF:src/a.ts", "DA:1,2", "DA:2,0", "end_of_record",
  "SF:src/b.ts", "DA:5,1", "DA:6,3", "end_of_record",
].join("\n");

const SINGLE_BLOCK_LCOV = ["SF:src/svc.ts", "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record"].join("\n");

// Absolute-path fixture: exercises the normalizeRepoPath first branch (isAbsolute &&
// startsWith(root + "/")) — path IS under repoDir and the simple prefix matches.
const ABSOLUTE_PATH_LCOV = [
  `SF:${REPO_DIR}/src/svc.ts`, "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record",
].join("\n");

// Absolute-path else-if fixture: exercises the normalizeRepoPath else-if (isAbsolute) fallback
// branch — path is absolute but the simple startsWith(root + "/") check does NOT match because
// the path has a double-slash prefix ("//workspace/..."). path.relative() normalizes and returns
// "src/foo.ts" (no ".." prefix), so the adapter MUST apply that relative result. Without the
// else-if fallback the adapter skips the relative() call and strip only the leading slashes via
// replace(/^\/+/, ""), producing "workspace/myapp/src/foo.ts" instead of "src/foo.ts".
const DOUBLE_SLASH_LCOV = [
  `SF://${REPO_DIR.slice(1)}/src/foo.ts`, "DA:7,1", "DA:8,2", "end_of_record",
].join("\n");

const fixtures: Array<{ lcov: string; repoDir?: string }> = [
  { lcov: TWO_BLOCK_LCOV, repoDir: REPO_DIR },
  { lcov: SINGLE_BLOCK_LCOV, repoDir: REPO_DIR },
  { lcov: ABSOLUTE_PATH_LCOV, repoDir: REPO_DIR },
  // Pins the else-if (isAbsolute) fallback branch restored in WF-04 + B2-C8-PARITY-FIXTURE-WEAK.
  // A double-slash absolute path fails startsWith(root+"/") but path.relative() resolves it to
  // "src/foo.ts". Without the else-if, the adapter produces "workspace/myapp/src/foo.ts" instead.
  { lcov: DOUBLE_SLASH_LCOV, repoDir: REPO_DIR },
  { lcov: "" },
];

test("PARITY: defaultParseLcov matches parseLcov across fixtures (including two-block multi-record and absolute SF paths)", () => {
  for (const { lcov, repoDir } of fixtures) {
    const legacy = parseLcov(lcov, repoDir);
    const local = defaultParseLcov(lcov, repoDir);
    // Convert both Maps to a plain comparable object for deepEqual
    const toObj = (m: Map<string, Set<number>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
    assert.deepEqual(toObj(local), toObj(legacy), `fixture: ${lcov.slice(0, 40)}`);
  }
});

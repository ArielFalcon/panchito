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

// Absolute-path fixture: exercises the normalizeRepoPath stripping — the divergence between the old
// defaultParseLcov (which did NOT strip absolute paths) and parseLcov (which does). Without the fix,
// this fixture would produce "/workspace/myapp/src/svc.ts" as the map key instead of "src/svc.ts",
// and the diff intersection (which uses repo-relative keys) would yield zero covered lines.
const ABSOLUTE_PATH_LCOV = [
  `SF:${REPO_DIR}/src/svc.ts`, "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record",
].join("\n");

const fixtures: Array<{ lcov: string; repoDir?: string }> = [
  { lcov: TWO_BLOCK_LCOV, repoDir: REPO_DIR },
  { lcov: SINGLE_BLOCK_LCOV, repoDir: REPO_DIR },
  { lcov: ABSOLUTE_PATH_LCOV, repoDir: REPO_DIR }, // parity on absolute SF: path normalization
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

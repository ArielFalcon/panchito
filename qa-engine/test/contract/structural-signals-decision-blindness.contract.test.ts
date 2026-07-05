// qa-engine/test/contract/structural-signals-decision-blindness.contract.test.ts
//
// Slice B (structural-signals-expansion, design §2/spec "Never read by decision logic"): the three
// new telemetry field names (structuralSignalBytes, serviceLinksCount, contractDriftCount) are
// PERSIST-ONLY — intended for the Phase-7 batch calibrator, never live UI/caller consumption or a
// verdict/gate/publish input. This is a static regression guard, not a behavioral test: it greps
// every decide/verdict/gate/publish source file and asserts NONE of them reference the three field
// names as identifiers. Only the two legitimate producers/consumers — the use-case's own
// construction-site literal (run-qa.use-case.ts) and the persistence adapter's mapping
// (run-history-sqlite-adapter.ts) — are allowed to reference the names at all.
//
// Written BEFORE the field names exist anywhere (B-R5, RED-authored per the tasks artifact): it
// trivially passes now (no file references a name that doesn't exist yet) and continues to hold as
// a permanent guard once B-G3/B-G4 introduce the names — a future change that starts branching a
// decide/verdict/gate/publish path on one of these fields will fail this test immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const qaEngineRoot = join(here, "..", "..");

// Every source file that owns a decide/verdict/gate/publish decision path. Deliberately an
// exhaustive allowlist of PATHS (not a glob) so a new decision file added later must be added here
// explicitly — the same "loud by construction" discipline the design applies to the telemetry
// fields themselves.
const DECISION_PATH_FILES = [
  "src/contexts/qa-run-orchestration/domain/run.aggregate.ts",
  "src/contexts/objective-signal/domain/decide-coverage.service.ts",
  "src/contexts/workspace-and-publication/domain/publish-decision.service.ts",
  "src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts",
  "src/contexts/qa-run-orchestration/domain/helpers/progress-gate.ts",
  "src/contexts/test-execution/domain/progress-gate.service.ts",
  "src/contexts/test-execution/domain/nav-gate.service.ts",
  "src/contexts/test-execution/infrastructure/static-gate.adapter.ts",
  "src/contexts/generation/infrastructure/catalog-gate.ts",
  "src/contexts/generation/infrastructure/verdict-parser.adapter.ts",
];

const STRUCTURAL_SIGNAL_TELEMETRY_FIELDS = ["structuralSignalBytes", "serviceLinksCount", "contractDriftCount"];

test("no decide/verdict/gate/publish source file references structuralSignalBytes/serviceLinksCount/contractDriftCount — persist-only telemetry, never a decision input", () => {
  for (const relPath of DECISION_PATH_FILES) {
    const content = readFileSync(join(qaEngineRoot, relPath), "utf8");
    for (const field of STRUCTURAL_SIGNAL_TELEMETRY_FIELDS) {
      assert.ok(
        !content.includes(field),
        `${relPath} references '${field}' — this field is persist-only telemetry (design §2/ADR-B) and must NEVER be read by a decide/verdict/gate/publish path`,
      );
    }
  }
});

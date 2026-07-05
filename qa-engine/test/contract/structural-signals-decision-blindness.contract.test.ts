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
//
// Slice C (structural-signals-expansion, design §3/spec scenario "Zero verdict/gate/publish
// coupling"): crossRepoImpact/impactedLinks/crossRepoImpactedCount extend the SAME guard (C-R8) —
// advisory-only, fail-open, never a decision input. Cross-repo change-coverage must independently
// stay "unknown" (never derived from this seam) — see the dedicated assertion below.
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
  "src/contexts/qa-run-orchestration/domain/run-decision.service.ts",
  "src/contexts/qa-run-orchestration/domain/adjudicate.service.ts",
  "src/contexts/test-execution/domain/adjudicate.service.ts",
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

// Slice C (C-R8): crossRepoImpact/impactedLinks/crossRepoImpactedCount must ALSO be blind to every
// decision path — same static guard, same file list, extended field set.
const CROSS_REPO_IMPACT_FIELDS = ["crossRepoImpact", "impactedLinks", "crossRepoImpactedCount"];

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

test("no decide/verdict/gate/publish source file references crossRepoImpact/impactedLinks/crossRepoImpactedCount — advisory-only, fail-open, never a decision input (Slice C, C-R8)", () => {
  for (const relPath of DECISION_PATH_FILES) {
    const content = readFileSync(join(qaEngineRoot, relPath), "utf8");
    for (const field of CROSS_REPO_IMPACT_FIELDS) {
      assert.ok(
        !content.includes(field),
        `${relPath} references '${field}' — CrossRepoImpactPort's composition is advisory-only (design §3/spec "Zero verdict/gate/publish coupling") and must NEVER be read by a decide/verdict/gate/publish path`,
      );
    }
  }
});

test("cross-repo change-coverage semantics stay 'unknown' — decide-coverage.service.ts never derives status from a cross-repo/triggerRepo signal", () => {
  const content = readFileSync(join(qaEngineRoot, "src/contexts/objective-signal/domain/decide-coverage.service.ts"), "utf8");
  assert.ok(
    !/triggerRepo|crossRepo/.test(content),
    "decide-coverage.service.ts must never branch on triggerRepo/crossRepo signals — cross-repo runs stay 'unknown' by construction (browser coverage cannot map service-repo lines), independent of CrossRepoImpactPort's own advisory result",
  );
});

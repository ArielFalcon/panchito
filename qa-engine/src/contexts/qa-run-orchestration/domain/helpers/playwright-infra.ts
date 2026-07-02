// qa-engine/src/contexts/qa-run-orchestration/domain/helpers/playwright-infra.ts
// PORT (verbatim) of PLAYWRIGHT_INFRA_RE from src/qa/execute.ts:127-128. Re-homed here rather than
// imported cross-context (test-execution/domain/adjudicate.service.ts already carries its OWN copy
// of this exact regex for its own, unrelated adjudicate() — a qa-run-orchestration import from
// test-execution's domain would violate the hexagonal boundary the same way a src/qa import would).
// Consumed by adjudicate.service.ts's Rule 1 (runner_infra classification).

// Narrow launch/host signatures ONLY — matched from Playwright's OWN error strings (the only
// channel it offers), kept narrow so a genuine failure is never relabeled as infra.
//
// `Target (page|context|browser) ... closed` is DELIBERATELY excluded: the app under test crashing
// the tab (a real defect the test SHOULD surface) produces the same string, so reclassifying it
// fail→infra-error would HIDE a genuine bug. Only unambiguous launch/host signatures stay here.
export const PLAYWRIGHT_INFRA_RE =
  /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;

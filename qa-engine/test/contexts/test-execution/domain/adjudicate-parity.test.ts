// PARITY: the lifted runner-infra classifier must match execute.ts byte-for-byte until Plan 7
// deletes the legacy original. Imports from src/ (outside qa-engine rootDir) — excluded from
// qa-engine typecheck (see qa-engine/tsconfig.json), runs via tsx at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdjudicateService, PLAYWRIGHT_INFRA_RE } from "@contexts/test-execution/domain/adjudicate.service.ts";
import {
  allFailuresAreRunnerInfra as legacyAllInfra,
  PLAYWRIGHT_INFRA_RE as LEGACY_RE,
} from "../../../../../src/qa/execute.ts";
import type { QaCase } from "../../../../../src/types.ts";

test("PARITY: the regex source matches legacy execute.ts", () => {
  assert.equal(PLAYWRIGHT_INFRA_RE.source, LEGACY_RE.source);
  assert.equal(PLAYWRIGHT_INFRA_RE.flags, LEGACY_RE.flags);
});

test("PARITY: runner-infra classification matches legacy across a sample table", () => {
  const svc = new AdjudicateService();
  const samples: QaCase[][] = [
    [{ name: "a", status: "fail", detail: "browserType.launch: Executable doesn't exist" }],
    [{ name: "a", status: "fail", detail: "expect timed out" }],
    [
      { name: "a", status: "fail", detail: "Failed to launch" },
      { name: "b", status: "fail", detail: "assertion mismatch" },
    ],
    [{ name: "a", status: "pass" }],
  ];
  for (const cases of samples) {
    const legacy = legacyAllInfra(cases);
    const adjudged = svc.adjudicate("fail", cases as QaCase[]).verdict === "infra-error";
    // Direct comparison: the `&& cases.some(…)` conjunction masked divergences because it turned a
    // false legacyAllInfra result into false regardless of adjudged (the compound is always false when
    // legacy is false, hiding cases where adjudged and legacy actually disagree).
    assert.equal(adjudged, legacy, JSON.stringify(cases));
  }
});

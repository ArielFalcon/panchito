// Probe script (Plan 6, Slice B.2) — runs each new scenario through the REAL legacy runPipeline
// ONCE to confirm the actual verdict + which side effect fired, before hardcoding those values in
// golden-outcome.harness.ts. Mirrors capture-goldens.ts's mechanism but does NOT write JSON golden
// files (golden-outcome.harness.ts asserts inline expectedVerdict/expectedSideEffect, it does not
// read from goldens/ — GATE A's "10 goldens" invariant in golden-parity.test.ts stays untouched).
// Run via: node --import ../../../test-setup.mjs --import tsx capture-goldens-b2.ts
import { runPipeline } from "../../../src/pipeline.ts";
import { buildScenarioDepsB2, type ScenarioKeyB2 } from "./scenarios.ts";
import { probeSideEffects } from "./side-effects.ts";

const KEYS: ScenarioKeyB2[] = [
  "static-repair-recovers",
  "coverage-enforce-blocks",
  "coverage-enforce-improves",
  "coverage-enforce-unknown",
  "fixloop-maxretries-zero",
  "adjudicator-app-defect",
  "adjudicator-runner-infra",
  "adjudicator-ambiguous-break",
  "w2-preexec-block",
  "codemode-infra-toolchain",
  "context-invalid",
];

for (const key of KEYS) {
  const { app, sha, source, opts, deps } = buildScenarioDepsB2(key);
  const { deps: probed, seen } = probeSideEffects(deps);
  const result = await runPipeline(app, sha, probed, source, opts);
  console.log(`${key}: verdict=${result.verdict} sideEffect=${seen()}`);
}

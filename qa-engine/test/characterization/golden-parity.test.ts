// test/characterization/golden-parity.test.ts
// GATE A (Plan 6, Slice A, Task A.4): the literal barrier. Converts the dormant round-trip net into
// a live regression gate — for each of the 10 scenarios, run LegacyPipelineAdapter.run() and assert
// runOutcomeEquivalent(adapter output, golden) === true, PLUS the expected side effect. Nothing
// downstream (Slices B-F) proceeds until this is 10/10 green. Imports the legacy runPipeline via the
// adapter constructor — in the qa-engine typecheck exclude list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";
import { runPipeline } from "../../../src/pipeline.ts";
import { LegacyPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import { buildScenarioDeps, type ScenarioKey } from "./scenarios.ts";
import { probeSideEffects, type SideEffect } from "./side-effects.ts";
import { loadAllowlist, fingerprint } from "./parity-allowlist.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";

// Structural aliases matching LegacyPipelineAdapter's intentionally opaque LegacyRunner type (see
// legacy-pipeline.adapter.ts) — the adapter stays src/-free at type level, so the real, concretely
// typed scenarios.ts CaptureDeps / src/pipeline.ts runPipeline need a structural cast at the call
// site. Runtime-compatible (same values), not a real behavior gap. Mirrors golden-outcome.test.ts's
// LegacyRunnerDeps/LegacyRunnerFn.
type LegacyRunnerDeps = { savedOutcomes?: KernelRunOutcome[] } & Record<string, unknown>;
type LegacyRunnerFn = (
  app: unknown,
  sha: string,
  deps: unknown,
  source: string,
  opts: unknown,
  ...cbs: unknown[]
) => Promise<{ verdict: string }>;

// Each committed golden must round-trip through the comparator against itself (sanity: the
// comparator accepts real captured shapes).
const dir = join(import.meta.dirname, "goldens");

test("goldens: all 10 canonical scenarios are captured", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 10, `expected 10 goldens, found ${files.length}`);
});

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  test(`golden ${file}: round-trips through the equivalence comparator`, () => {
    const golden = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const asComparable: ComparableOutcome = { runId: "x", at: "y", ...golden };
    assert.equal(runOutcomeEquivalent(asComparable, asComparable).equal, true);
  });
}

// ── GATE A — LegacyPipelineAdapter output ≡ golden + side effects ──────────────────────────────

// Maps each scenario's expected side effect from its golden verdict. The equivalence comparator
// does not model side effects (which publish/issue path fired) — this is a SEPARATE assertion.
const EXPECTED_SIDE_EFFECT: Record<ScenarioKey, SideEffect> = {
  "green-pr": "pr",
  "fail-issue": "issue",
  "flaky-quarantine": "none",
  "no-op-skip": "none",
  "invalid-issue": "issue",
  "infra-error": "none",
  "code-mode": "pr",
  "cross-repo": "pr",
  shadow: "shadow-log",
  context: "pr",
};

const allow = loadAllowlist();

for (const key of Object.keys(EXPECTED_SIDE_EFFECT) as ScenarioKey[]) {
  test(`GATE A — ${key}: LegacyPipelineAdapter output ≡ golden + side effect`, async () => {
    const golden = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as Partial<ComparableOutcome>;
    const { app, sha, source, opts, deps } = buildScenarioDeps(key);
    const { deps: probed, seen } = probeSideEffects(deps);
    const adapter = new LegacyPipelineAdapter({
      app,
      deps: probed as unknown as LegacyRunnerDeps,
      runPipeline: runPipeline as unknown as LegacyRunnerFn,
      legacyOpts: opts.triggerRepo ? { triggerRepo: opts.triggerRepo } : undefined,
    });
    const outcome = await adapter.run({
      app: app.name,
      sha: Sha.of(sha),
      source,
      mode: opts.mode,
      target: opts.target ?? "e2e",
      guidance: undefined,
      runId: opts.runId!,
    });

    const declared = allow.has(fingerprint(key));
    const cmp = runOutcomeEquivalent(
      { runId: "x", at: "y", ...(golden as object) } as ComparableOutcome,
      { runId: "x", at: "y", ...(outcome as object) } as ComparableOutcome,
    );
    if (!declared) assert.equal(cmp.equal, true, `${key}: ${cmp.diff}`); // undeclared divergence FAILS
    assert.equal(seen(), EXPECTED_SIDE_EFFECT[key], `${key}: wrong side effect`);

    // Shape assertion OUTSIDE the comparator (comparator hazard): the comparator ignores these
    // fields, so a 0-vs-undefined mismatch is invisible. The context golden OMITS them
    // (synthesized), so skip the assert for the context scenario; for every other scenario the
    // legacy adapter MUST emit the NUMBER 0, not undefined. This pins the field SHAPE at GATE A.
    if (key !== "context") {
      assert.equal(
        typeof outcome.gateSignals.preExecAmbiguityCatches,
        "number",
        `${key}: preExecAmbiguityCatches must be a number, not undefined`,
      );
      assert.equal(
        typeof outcome.gateSignals.deterministicSelectorBlocks,
        "number",
        `${key}: deterministicSelectorBlocks must be a number, not undefined`,
      );
    }
  });
}

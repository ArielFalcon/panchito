// Captures legacy runPipeline RunOutcome goldens, sanitized (runId/at stripped), for the 10
// canonical scenarios. Run via: node --import ../../../test-setup.mjs --import tsx capture-goldens.ts
// It reuses the SAME stub shape pipeline.test.ts uses. Each scenario mirrors an existing test's
// deps; do NOT invent behavior. The output JSON is committed and becomes the parity baseline.
//
// NOTE on "context" scenario: context mode returns early before persistOutcome is called (the mode
// is a maintenance task — it builds the architecture map, not a test suite). The golden is
// synthesized from the QaRunResult return value, using the same fields and defaults that persistOutcome
// would apply, so the golden is structurally valid and round-trips through the comparator.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../../../src/pipeline.ts";
import type { RunOutcome } from "../../../src/types.ts";
import { buildScenarioDeps, type ScenarioKey } from "./scenarios.ts";

const KEYS: ScenarioKey[] = [
  "green-pr",
  "fail-issue",
  "flaky-quarantine",
  "no-op-skip",
  "invalid-issue",
  "infra-error",
  "code-mode",
  "cross-repo",
  "shadow",
  "context",
];

// Strip per-invocation, non-behavioral fields so the committed golden is deterministic and
// re-capture is idempotent. `runId`/`at` are unique per run; `gateSignals.phaseTimings` are
// wall-clock durations (ms) and `gateSignals.usage` are token/cost counters — both vary by
// run and machine. The equivalence comparator already excludes all of these from its behavioral
// projection; dropping them here keeps the golden free of spurious diffs that masquerade as
// behavior changes (a 1ms→0ms timing jitter once looked like a real change).
function sanitize(o: RunOutcome): Record<string, unknown> {
  const { runId: _r, at: _a, ...rest } = o;
  const { phaseTimings: _pt, usage: _u, ...stableSignals } = rest.gateSignals;
  return { ...rest, gateSignals: stableSignals };
}

// context mode does NOT call persistOutcome (it returns early as a maintenance task). Synthesize the
// golden from the QaRunResult returned by runPipeline, using the same defaults persistOutcome applies.
function synthesizeContextOutcome(verdict: string, app: string, sha: string): RunOutcome {
  return {
    runId: "golden-context",
    app,
    sha,
    mode: "context",
    target: "e2e",
    verdict: verdict as RunOutcome["verdict"],
    errorClass: null,
    gateSignals: {
      static: false,
      coverageRatio: null,
      valueScore: null,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: new Date().toISOString(),
  };
}

const outDir = join(import.meta.dirname, "goldens");
mkdirSync(outDir, { recursive: true });

for (const key of KEYS) {
  const { app, sha, source, opts, deps } = buildScenarioDeps(key);
  const pipelineResult = await runPipeline(app, sha, deps, source, opts);

  let outcome: RunOutcome;
  if (key === "context") {
    // context mode returns early; no RunOutcome is persisted via saveOutcome.
    outcome = synthesizeContextOutcome(pipelineResult.verdict, app.name, sha);
  } else {
    const saved = deps.savedOutcomes[0];
    if (!saved) throw new Error(`scenario ${key}: no RunOutcome was saved`);
    outcome = saved;
  }

  writeFileSync(join(outDir, `${key}.json`), JSON.stringify(sanitize(outcome), null, 2) + "\n");
  console.log(`captured ${key}`);
}

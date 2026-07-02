// test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts
// RED-first parity test (Plan 6 Slice A, Task A.1): drives LegacyPipelineAdapter with the existing
// scenarios.ts green-pr stub and asserts it forwards to the injected runPipeline and returns the
// SAVED RunOutcome (not a re-derivation from QaRunResult). A gutted impl returning a literal FAILS
// this test. Imports src/pipeline.ts's runPipeline as the wrapped dependency — added to the qa-engine
// typecheck exclude list (the established parity-import pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LegacyPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import { buildScenarioDeps } from "../../../characterization/scenarios.ts";
import { runPipeline } from "../../../../../src/pipeline.ts";

test("run() delegates to runPipeline and returns the SAVED RunOutcome (verdict pass for green-pr)", async () => {
  const { app, sha, source, opts, deps } = buildScenarioDeps("green-pr");
  const adapter = new LegacyPipelineAdapter({ app, deps, runPipeline });
  const outcome = await adapter.run({
    app: app.name,
    sha: Sha.of(sha),
    source,
    mode: opts.mode,
    target: opts.target ?? "e2e",
    runId: opts.runId!,
  });
  assert.equal(outcome.verdict, "pass");
  assert.equal(deps.savedOutcomes.length >= 1, true, "the wrapped runPipeline must have saved an outcome");
  // Not a gutted literal: the adapter must surface the REAL saved outcome's app/sha, not a stub.
  assert.equal(outcome.app, app.name);
  assert.equal(outcome.sha, sha);
});

test("run() synthesizes a context-mode outcome when runPipeline returns before saveOutcome", async () => {
  const { app, sha, source, opts, deps } = buildScenarioDeps("context");
  const adapter = new LegacyPipelineAdapter({ app, deps, runPipeline });
  const outcome = await adapter.run({
    app: app.name,
    sha: Sha.of(sha),
    source,
    mode: opts.mode,
    target: opts.target ?? "e2e",
    runId: opts.runId!,
  });
  assert.equal(deps.savedOutcomes.length, 0, "context mode must not call saveOutcome");
  assert.equal(outcome.mode, "context");
  assert.equal(outcome.app, app.name);
  assert.equal(outcome.sha, sha);
});

test("run() threads legacyOpts (e.g. triggerRepo) over the derived opts without widening RunInput", async () => {
  const { app, sha, source, opts, deps } = buildScenarioDeps("cross-repo");
  const adapter = new LegacyPipelineAdapter({
    app,
    deps,
    runPipeline,
    legacyOpts: { triggerRepo: opts.triggerRepo },
  });
  const outcome = await adapter.run({
    app: app.name,
    sha: Sha.of(sha),
    source,
    mode: opts.mode,
    target: opts.target ?? "e2e",
    runId: opts.runId!,
  });
  assert.equal(outcome.verdict, "pass");
  assert.equal(deps.savedOutcomes.length >= 1, true);
});

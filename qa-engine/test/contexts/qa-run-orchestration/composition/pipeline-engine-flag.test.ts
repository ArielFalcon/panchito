// test/contexts/qa-run-orchestration/composition/pipeline-engine-flag.test.ts
// Plan 7.6 (cutover finale): the legacy engine is deleted — selectEngine ALWAYS resolves to
// "rewritten" now, regardless of PIPELINE_ENGINE. Only the explicit "legacy" value gets a
// (once-only) deprecation warning, since it can no longer be honored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEngine, PIPELINE_ENGINE } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts";

test("selectEngine returns rewritten when PIPELINE_ENGINE is absent", () => {
  assert.equal(selectEngine({}), "rewritten");
});

test("selectEngine returns rewritten for the explicit 'rewritten' value", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "rewritten" }), "rewritten");
});

test("selectEngine returns rewritten even when 'legacy' is explicitly requested (accepted-but-ignored)", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "legacy" }), "rewritten");
});

test("selectEngine returns rewritten for any other/garbage value", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "REWRITTEN" }), "rewritten");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: " rewritten" }), "rewritten");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "garbage" }), "rewritten");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "" }), "rewritten");
});

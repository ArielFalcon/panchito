// test/contexts/qa-run-orchestration/composition/pipeline-engine-flag.test.ts
// RED-first (Task E.1): selectEngine reads PIPELINE_ENGINE and returns the fail-safe default "legacy"
// for absent/"legacy"/any-other value, and "rewritten" ONLY on the exact "rewritten" string. This is
// the shadow seam (design §7.3 Step 2) — Plan 6 NEVER ships rewritten as the default; the cutover
// (flip default) is Plan 7, justified by the Slice F shadow evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEngine, PIPELINE_ENGINE } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts";

test("selectEngine defaults to legacy when PIPELINE_ENGINE is absent (fail-safe)", () => {
  assert.equal(selectEngine({}), "legacy");
});

test("selectEngine returns legacy for the explicit 'legacy' value", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "legacy" }), "legacy");
});

test("selectEngine returns rewritten ONLY on the exact 'rewritten' value", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "rewritten" }), "rewritten");
});

test("selectEngine fails safe to legacy for any non-exact value (case/whitespace/garbage)", () => {
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "REWRITTEN" }), "legacy");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: " rewritten" }), "legacy");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "rewrite" }), "legacy");
  assert.equal(selectEngine({ [PIPELINE_ENGINE]: "" }), "legacy");
});

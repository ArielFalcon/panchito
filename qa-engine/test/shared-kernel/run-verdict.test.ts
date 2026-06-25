// qa-engine/test/shared-kernel/run-verdict.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { engineStatus, RUN_ENGINE_STATUSES, type RunVerdict } from "@kernel/run-verdict.ts";
import { RUN_MODES } from "@kernel/run-mode.ts";

test("engineStatus: invalid and infra-error are ERROR; everything else is SUCCESS", () => {
  assert.equal(engineStatus("invalid"), RUN_ENGINE_STATUSES.ERROR);
  assert.equal(engineStatus("infra-error"), RUN_ENGINE_STATUSES.ERROR);
  for (const v of ["pass", "fail", "flaky", "skipped"] as RunVerdict[]) {
    assert.equal(engineStatus(v), RUN_ENGINE_STATUSES.SUCCESS);
  }
});

test("engineStatus: null/undefined is fail-safe ERROR (no verdict ⇒ did not succeed)", () => {
  assert.equal(engineStatus(null), RUN_ENGINE_STATUSES.ERROR);
  assert.equal(engineStatus(undefined), RUN_ENGINE_STATUSES.ERROR);
});

test("RUN_MODES lists exactly the five run modes", () => {
  assert.deepEqual([...RUN_MODES], ["diff", "complete", "exhaustive", "manual", "context"]);
});

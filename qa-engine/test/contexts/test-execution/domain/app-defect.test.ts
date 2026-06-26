import { test } from "node:test";
import assert from "node:assert/strict";
import { AppDefect } from "@contexts/test-execution/domain/app-defect.ts";

test("fromHttpStatus marks a 5xx as a defect with the status as evidence", () => {
  const d = AppDefect.fromHttpStatus(503);
  assert.equal(d.isDefect, true);
  assert.equal(d.httpStatus, 503);
  assert.match(d.evidence, /503/);
});

test("fromHttpStatus treats a 2xx as no defect", () => {
  const d = AppDefect.fromHttpStatus(200);
  assert.equal(d.isDefect, false);
  assert.equal(d.httpStatus, 200);
});

test("fromRunnerInfra marks a runner-infrastructure fault as a defect (no httpStatus)", () => {
  const d = AppDefect.fromRunnerInfra("browserType.launch failed");
  assert.equal(d.isDefect, true);
  assert.equal(d.httpStatus, null);
  assert.match(d.evidence, /browserType\.launch/);
});

test("none() is the no-defect singleton", () => {
  assert.equal(AppDefect.none().isDefect, false);
  assert.equal(AppDefect.none().httpStatus, null);
});

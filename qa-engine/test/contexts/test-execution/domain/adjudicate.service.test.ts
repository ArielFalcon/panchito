import { test } from "node:test";
import assert from "node:assert/strict";
import { AdjudicateService } from "@contexts/test-execution/domain/adjudicate.service.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const svc = new AdjudicateService();
const c = (status: QaCase["status"], detail?: string): QaCase =>
  ({ name: "t", status, ...(detail ? { detail } : {}) }) as QaCase;

test("a fail where EVERY failure is runner-infra adjudicates to infra-error", () => {
  const r = svc.adjudicate("fail", [c("fail", "browserType.launch: Executable doesn't exist")]);
  assert.equal(r.verdict, "infra-error");
  assert.equal(r.appDefect.isDefect, true);
});

test("a fail with a genuine assertion failure stays fail (one real failure poisons the infra reclassification)", () => {
  const r = svc.adjudicate("fail", [
    c("fail", "browserType.launch failed"),
    c("fail", "expect(locator).toBeVisible timed out"),
  ]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.appDefect.isDefect, false);
});

test("a pass is passed through unchanged", () => {
  const r = svc.adjudicate("pass", [c("pass")]);
  assert.equal(r.verdict, "pass");
  assert.equal(r.appDefect.isDefect, false);
});

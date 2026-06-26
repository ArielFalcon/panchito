import { test } from "node:test";
import assert from "node:assert/strict";
import { SelectorCheckService } from "@contexts/test-execution/domain/selector-check.service.ts";

const DOM_TREE = ["button: Submit"];

test("flags a getByRole selector absent from the captured DOM (verifiable-absent contradiction)", () => {
  const svc = new SelectorCheckService();
  const findings = svc.check(
    [`await page.getByRole("button", { name: "Buy now" }).click();`],
    [DOM_TREE],
  );
  assert.ok(findings.contradictions.some((c) => /Buy now/.test(c)));
  assert.ok(findings.absentKeys.size > 0);
  assert.equal(findings.anyVerifiedPresent, false);
});

test("passes when every selector resolves against the DOM (no contradictions)", () => {
  const svc = new SelectorCheckService();
  const findings = svc.check(
    [`await page.getByRole("button", { name: "Submit" }).click();`],
    [DOM_TREE],
  );
  assert.deepEqual(findings.contradictions, []);
  assert.equal(findings.anyVerifiedPresent, true);
  assert.equal(findings.absentKeys.size, 0);
});

test("non-extractable locator sets anyNonExtractable (getByTestId)", () => {
  const svc = new SelectorCheckService();
  const findings = svc.check(
    [`await page.getByTestId("submit-btn").click();`],
    [DOM_TREE],
  );
  assert.equal(findings.anyNonExtractable, true);
});

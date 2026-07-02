import { test } from "node:test";
import assert from "node:assert/strict";
import type { QaCase } from "@kernel/qa-case.ts";

// G1 (addendum §2, HIGH): src/types.ts's QaCase carries `runtimeErrors` (feature B — app-defect
// detection via browser console/page-error capture); the kernel QaCase did not, before this task.
// Any characterization scenario exercising Rule 2.6 (runtime-error -> app_defect) could not
// reproduce through the port -- a false-green surface INSIDE the safety net. This test asserts the
// kernel VO structurally accepts the same shape as src/types.ts's QaCase.runtimeErrors
// (`{ type: string; text: string }[]`), including the absent-warned best-effort contract (optional,
// omittable). Type-level acceptance is the "test" here since QaCase is a plain data interface with
// no constructor/guard to unit-test — the compiler is the RED/GREEN oracle (tsc rejects the
// `runtimeErrors` field pre-widen, accepts it post-widen).

test("QaCase: accepts runtimeErrors as an optional array of { type, text } (mirrors src/types.ts QaCase.runtimeErrors)", () => {
  const withRuntimeErrors: QaCase = {
    name: "checkout flow",
    status: "fail",
    runtimeErrors: [
      { type: "console.error", text: "TypeError: cannot read properties of undefined" },
      { type: "pageerror", text: "Uncaught ReferenceError: foo is not defined" },
    ],
  };
  assert.equal(withRuntimeErrors.runtimeErrors?.length, 2);
  assert.equal(withRuntimeErrors.runtimeErrors?.[0]?.type, "console.error");
  assert.equal(withRuntimeErrors.runtimeErrors?.[1]?.text, "Uncaught ReferenceError: foo is not defined");
});

test("QaCase: runtimeErrors stays absent-warned — a case without it is still a valid QaCase", () => {
  const withoutRuntimeErrors: QaCase = { name: "login flow", status: "pass" };
  assert.equal(withoutRuntimeErrors.runtimeErrors, undefined);
});

test("QaCase: runtimeErrors can be an empty array — degrades to string-only behavior, never a guessed value", () => {
  const emptyRuntimeErrors: QaCase = { name: "search flow", status: "pass", runtimeErrors: [] };
  assert.deepEqual(emptyRuntimeErrors.runtimeErrors, []);
});

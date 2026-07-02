// test/contexts/qa-run-orchestration/infrastructure/execution-evidence-flow.test.ts
// G1 kernel widening — end-to-end evidence-flow pin: proves the runtime evidence a failing case
// carries (httpStatus, runtimeErrors, and friends) survives BOTH boundaries it must cross before
// the FixLoop aggregate can read it for adjudicator Rules 2.5/2.6 and Lever-2:
//   1. E2eExecutionStrategy.run() — the legacy runE2E result -> kernel QaCase (test-execution
//      infrastructure layer; pinned in isolation by e2e-execution.strategy.test.ts).
//   2. ExecutionPortAdapter.execute() — the ExecutionPort bridge in front of the strategy
//      (qa-run-orchestration infrastructure layer; the layer the FixLoop actually depends on).
// Imports ONLY qa-engine modules via @contexts/... aliases — no src/ import, so no tsconfig
// exclude is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";

test("runtime evidence (httpStatus, runtimeErrors) crosses both the strategy and the ExecutionPort adapter boundary", async () => {
  const evidenceCase = {
    name: "checkout submits order",
    status: "fail" as const,
    detail: "expect(received).toBe(200)",
    file: "e2e/checkout.spec.ts",
    httpStatus: 503,
    finalUrl: "https://dev.example.com/checkout",
    runtimeErrors: [{ type: "pageerror", text: "TypeError: cannot read properties of undefined" }],
  };
  const e2e = new E2eExecutionStrategy(async () => ({
    verdict: "fail",
    cases: [evidenceCase],
    logs: "1 failed",
  }));
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter(
    { e2e, code },
    { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-evidence1" },
  );

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "fail");
  assert.equal(result.cases.length, 1);
  const [got] = result.cases;
  assert.equal(got?.httpStatus, 503, "httpStatus must survive both the strategy and adapter boundary");
  assert.deepEqual(
    got?.runtimeErrors,
    [{ type: "pageerror", text: "TypeError: cannot read properties of undefined" }],
    "runtimeErrors must survive both the strategy and adapter boundary",
  );
  assert.equal(got?.file, "e2e/checkout.spec.ts", "file must survive both boundaries (FixLoop re-run targeting)");
  assert.equal(got?.finalUrl, "https://dev.example.com/checkout", "finalUrl must survive both boundaries");
});

// test/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.test.ts
// RED-first (Task E.0): ExecutionPortAdapter dispatches between the REAL e2e/code strategies
// (E2eExecutionStrategy / CodeExecutionStrategy), both implementing ExecutionStrategyPort.run(req).
// THIN — no new policy: this bridge only maps ExecutionPort.execute(specDir) onto the richer
// ExecutionRequest shape (baseUrl/namespace held as static per-run context) and selects the
// strategy by target ("e2e" vs "code").
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";

test("execute() dispatches to E2eExecutionStrategy for target 'e2e' and forwards baseUrl/namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [{ name: "checkout", status: "pass" }], logs: `ran ${specDir}` };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.cases, [{ name: "checkout", status: "pass" }]);
  assert.match(result.logs, /\/mirrors\/org\/app\/e2e/);
  assert.equal((capturedOpts as { baseUrl: string }).baseUrl, "https://dev.example.com");
  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-abc1234");
});

test("execute() dispatches to CodeExecutionStrategy for target 'code' (no baseUrl required)", async () => {
  let called = false;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (repoDir, opts) => {
    called = true;
    return { verdict: "fail", cases: [{ name: "unit test A", status: "fail", detail: "AssertionError" }], logs: `code run ${repoDir} ns=${opts.namespace}` };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  const result = await adapter.execute("/mirrors/org/app");

  assert.equal(called, true);
  assert.equal(result.verdict, "fail");
  assert.equal(result.cases.length, 1);
});

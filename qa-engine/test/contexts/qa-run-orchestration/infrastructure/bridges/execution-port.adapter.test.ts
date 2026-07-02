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

// ── Plan 7.2 — leaf-signal forwarding (closes engram #916): the ExecutionPort barrel already
// declares execute(specDir, signal?) (Plan 7.1), and E2eExecutionStrategy/CodeExecutionStrategy
// already forward ExecutionRequest.signal into runE2E/runCodeTests's own opts.signal — this
// adapter is the ONLY missing link. It must declare + forward the signal, or the queue's
// AbortSignal is silently dropped before it ever reaches Playwright/the code runner.

test("execute() forwards an AbortSignal into the e2e strategy's ExecutionRequest", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedSignal = opts.signal;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to execute() must reach the e2e strategy's ExecutionRequest.signal, not be dropped at the bridge");
});

test("execute() forwards an AbortSignal into the code strategy's ExecutionRequest", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (_repoDir, opts) => {
    capturedSignal = opts.signal;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  await adapter.execute("/mirrors/org/app", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to execute() must reach the code strategy's ExecutionRequest.signal, not be dropped at the bridge");
});

// A3: testIdAttribute must reach the e2e strategy so PW_TEST_ID_ATTRIBUTE is set for the verdictual
// Playwright run — otherwise getByTestId silently resolves the default data-testid on non-default apps.
test("execute() forwards testIdAttribute from static context into the e2e strategy's ExecutionRequest", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter(
    { e2e, code },
    { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234", testIdAttribute: "data-cy" },
  );

  await adapter.execute("/mirrors/org/app/e2e");

  assert.equal((capturedOpts as { testIdAttribute?: string }).testIdAttribute, "data-cy");
});

test("execute() with no signal at all behaves exactly as before (no second-arg regression)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.equal((capturedOpts as { signal?: AbortSignal }).signal, undefined, "an absent signal must remain absent downstream — no fabricated AbortSignal");
});

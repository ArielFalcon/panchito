// test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { ExecutionRequest } from "@contexts/test-execution/application/ports/index.ts";

// ExecutionRequest carries the full set of ExecuteOptions / CodeExecuteOptions fields so no
// capability is silently dropped at the port boundary:
//   e2e: project? (PW --project), onCase?, onRunning?, onDiscovered? (live progress callbacks)
//   code: changedFiles? (diff-driven module scoping)
const req: ExecutionRequest = { specDir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" };

test("delegates to runE2E with the mapped opts and returns the verdict/cases/logs", async () => {
  let seen: { dir: string; baseUrl: string; namespace: string } | null = null;
  const strategy = new E2eExecutionStrategy(async (dir, opts) => {
    seen = { dir, baseUrl: opts.baseUrl, namespace: opts.namespace };
    return { sha: "abc", verdict: "pass", passed: true, cases: [{ name: "t", status: "pass" }], logs: "ok" };
  });
  const out = await strategy.run(req);
  assert.deepEqual(seen, { dir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" });
  assert.equal(out.verdict, "pass");
  assert.equal(out.cases.length, 1);
  assert.equal(out.logs, "ok");
});

test("runs the result through AdjudicateService — all-runner-infra fail becomes infra-error", async () => {
  const strategy = new E2eExecutionStrategy(async () => ({
    sha: "abc", verdict: "fail", passed: false,
    cases: [{ name: "t", status: "fail", detail: "browserType.launch: Executable doesn't exist" }],
    logs: "boom",
  }));
  const out = await strategy.run(req);
  assert.equal(out.verdict, "infra-error");
});

test("throws when baseUrl is absent (e2e requires a live DEV URL)", async () => {
  const strategy = new E2eExecutionStrategy(async () => ({ sha: "abc", verdict: "pass", passed: true, cases: [], logs: "" }));
  await assert.rejects(() => strategy.run({ specDir: "/m/e2e", namespace: "qa-abc" }), /baseUrl/);
});

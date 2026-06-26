// test/contexts/test-execution/infrastructure/code-execution.strategy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";

test("delegates to the injected code runner and passes through verdict/cases/logs", async () => {
  let seenDir = "";
  const strategy = new CodeExecutionStrategy(async (dir) => {
    seenDir = dir;
    return { verdict: "pass", cases: [{ name: "exit-0", status: "pass" }], logs: "ok" };
  });
  const out = await strategy.run({ specDir: "/m", namespace: "qa-abc" });
  assert.equal(seenDir, "/m");
  assert.equal(out.verdict, "pass");
  assert.equal(out.cases[0]?.status, "pass");
});

test("a non-zero exit is a fail (binary classify — no flaky)", async () => {
  const strategy = new CodeExecutionStrategy(async () => ({ verdict: "fail", cases: [{ name: "exit-1", status: "fail" }], logs: "exit 1" }));
  const out = await strategy.run({ specDir: "/m", namespace: "qa-abc" });
  assert.equal(out.verdict, "fail");
});

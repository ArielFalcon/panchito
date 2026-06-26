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

// TE-02: pin optional-field threading — a silently-dropped changedFiles breaks monorepo
// diff-driven module scoping (narrows the test command to the changed module) with no failing test.
test("threads namespace to the injected runCode fn", async () => {
  type Opts = { namespace: string; changedFiles?: string[] };
  let capturedOpts: Opts | null = null;
  const strategy = new CodeExecutionStrategy(async (_dir, opts) => {
    capturedOpts = opts as Opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  await strategy.run({ specDir: "/m", namespace: "qa-bot-abc" });
  assert.ok(capturedOpts !== null, "runCode fn must be called");
  assert.equal((capturedOpts as Opts).namespace, "qa-bot-abc", "namespace must be threaded");
});

test("threads changedFiles to the injected runCode fn for diff-driven module scoping", async () => {
  type Opts = { namespace: string; changedFiles?: string[] };
  let capturedOpts: Opts | null = null;
  const strategy = new CodeExecutionStrategy(async (_dir, opts) => {
    capturedOpts = opts as Opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  await strategy.run({ specDir: "/m", namespace: "qa-bot-abc", changedFiles: ["src/orders.ts", "src/orders.test.ts"] });
  assert.ok(capturedOpts !== null, "runCode fn must be called");
  assert.deepEqual((capturedOpts as Opts).changedFiles, ["src/orders.ts", "src/orders.test.ts"], "changedFiles must be threaded for module scoping");
});

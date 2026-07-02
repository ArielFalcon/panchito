// qa-engine/test/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.test.ts
// Behavioral tests over REAL spawned processes (leaf IO — test the real behavior, not a mock),
// matching the pattern established for ProcessKillAdapter/scrubEnv in this same directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxedBinaryRunnerAdapter } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { ProcessKillPort } from "../../../src/shared-kernel/process-sandbox/process-kill.port.ts";
// Import depth: from qa-engine/test/shared-infrastructure/process-sandbox/ → qa-engine/src/ is 3 levels
// up (../../../), matching process-kill.test.ts and scrub-env.test.ts in this same directory.

function makeAdapter(processKill: ProcessKillPort = new ProcessKillAdapter()): SandboxedBinaryRunnerAdapter {
  return new SandboxedBinaryRunnerAdapter({ processKill });
}

test("run() spawns a real command and captures exitCode + stdout", async () => {
  const adapter = makeAdapter();
  const result = await adapter.run({
    command: process.execPath, // node itself — no PATH lookup surprises
    args: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
});

test("run() captures stderr and a non-zero exitCode", async () => {
  const adapter = makeAdapter();
  const result = await adapter.run({
    command: process.execPath,
    args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, "boom");
  assert.equal(result.timedOut, false);
});

test("run() honors cwd — the spawned command sees it as its working directory", async () => {
  const adapter = makeAdapter();
  const result = await adapter.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: "/tmp",
    env: { PATH: process.env.PATH ?? "" },
  });
  // macOS /tmp is a symlink to /private/tmp; realpath both sides so this holds cross-platform.
  const { realpathSync } = await import("node:fs");
  assert.equal(realpathSync(result.stdout.trim()), realpathSync("/tmp"));
});

test("run() kills the process tree on timeout and reports timedOut:true", async () => {
  const killed: number[] = [];
  const spyKill: ProcessKillPort = {
    killTree(child) {
      if (child.pid) killed.push(child.pid);
      new ProcessKillAdapter().killTree(child); // still actually reap it — no leaked children
    },
  };
  const adapter = makeAdapter(spyKill);
  const start = Date.now();
  const result = await adapter.run({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"], // would hang for 60s without a timeout kill
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 200,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 5000, `expected a fast kill, took ${elapsed}ms`);
  assert.equal(killed.length, 1);
});

test("run() kills the process tree on abort and reports timedOut:true", async () => {
  const killed: number[] = [];
  const spyKill: ProcessKillPort = {
    killTree(child) {
      if (child.pid) killed.push(child.pid);
      new ProcessKillAdapter().killTree(child);
    },
  };
  const adapter = makeAdapter(spyKill);
  const controller = new AbortController();
  const runPromise = adapter.run({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  const result = await runPromise;
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 5000, `expected a fast abort-kill, took ${elapsed}ms`);
  assert.equal(killed.length, 1);
});

test("run() resolves normally when an already-fired signal has no listener race (no leaked timers)", async () => {
  const adapter = makeAdapter();
  const result = await adapter.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('fast')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "fast");
  assert.equal(result.timedOut, false);
});

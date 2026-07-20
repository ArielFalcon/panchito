// qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
// Import depth: from qa-engine/test/shared-infrastructure/process-sandbox/ → qa-engine/src/ is 3 levels up
// (../../../). 4 levels would reach the repo root (panchito/src/), which is wrong.

function fakeChild(pid: number | undefined, killSpy: string[]): ChildProcess {
  return { pid, kill(sig?: string) { killSpy.push(`direct:${sig}`); return true; } } as unknown as ChildProcess;
}

test("killTree signals the whole process group when a pid is present", () => {
  const calls: Array<[number, string]> = [];
  const adapter = new ProcessKillAdapter((pid, sig) => { calls.push([pid, sig]); });
  adapter.killTree(fakeChild(1234, []));
  assert.deepEqual(calls, [[-1234, "SIGKILL"]]); // negative pid ⇒ process group
});

test("killTree falls back to a direct kill when the group send throws", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("ESRCH"); });
  adapter.killTree(fakeChild(1234, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});

test("killTree kills directly when there is no pid", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("should not be called"); });
  adapter.killTree(fakeChild(undefined, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});

// judgment-day round 3 (FIX A, Judge A): every real caller (sandboxed-binary-runner.adapter.ts,
// code-execution.runner.ts, e2e-execution.runner.ts, static-gate.checks.ts, code-setup.ts,
// stryker-mutation-oracle.adapter.ts, dom-snapshot.ts, codebase-memory-client.ts) instantiates
// `new ProcessKillAdapter()` with NO args — i.e. every real timeout/abort kill path in the codebase
// runs through the DEFAULT `kill` param. The 3 tests above only ever inject a fake kill fn, so a
// neutered default ((pid, sig) => {}) passed `npm test` while silently disabling every real kill.
// This test is the missing pin: it proves the DEFAULT (no constructor arg) actually reaches
// process.kill, by monkeypatching the real global (a plain writable property, not an ESM-frozen
// export — process.kill is safely restorable via t.after).
test("the DEFAULT kill function (no constructor arg) actually invokes process.kill", (t) => {
  const calls: Array<[number, string]> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    calls.push([pid, String(signal)]);
    return true;
  }) as typeof process.kill;
  t.after(() => {
    process.kill = originalKill;
  });

  const adapter = new ProcessKillAdapter(); // no injected kill fn — exercises the real default
  adapter.killTree(fakeChild(1234, []));

  assert.deepEqual(calls, [[-1234, "SIGKILL"]]); // negative pid ⇒ process group
});

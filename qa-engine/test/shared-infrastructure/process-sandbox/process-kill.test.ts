// qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
// Import depth: from qa-engine/test/shared-infrastructure/process-sandbox/ → qa-engine/src/ is 3 levels up
// (../../../). 4 levels would reach the repo root (ai-pipeline/src/), which is wrong.

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

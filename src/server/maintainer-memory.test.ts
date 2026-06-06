import { test } from "node:test";
import assert from "node:assert/strict";
import { readFixFailures, recordFixFailure, renderFailureMemory, MemoryFs, FixFailure } from "./maintainer-memory";

function fakeFs(): MemoryFs & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (p) => store.get(p) ?? null,
    write: (p, s) => void store.set(p, s),
    remove: (p) => void store.delete(p),
  };
}

test("records and reads fix failures, capped to the most recent", () => {
  const fs = fakeFs();
  const path = "/data/maintainer-failures.json";
  for (let i = 0; i < 25; i++) {
    recordFixFailure(path, { at: `t${i}`, reason: "canary-unhealthy" }, fs, 20);
  }
  const all = readFixFailures(path, fs);
  assert.equal(all.length, 20, "capped at keep=20");
  assert.equal(all[0]!.at, "t5", "drops the oldest");
  assert.equal(all[19]!.at, "t24", "keeps the newest");
});

test("readFixFailures tolerates a missing or corrupt file", () => {
  const fs = fakeFs();
  assert.deepEqual(readFixFailures("/nope", fs), []);
  fs.store.set("/bad", "not json");
  assert.deepEqual(readFixFailures("/bad", fs), []);
});

test("renderFailureMemory is empty when there is nothing to warn about", () => {
  assert.equal(renderFailureMemory([]), "");
});

test("renderFailureMemory surfaces the recent failures with their assumed root cause", () => {
  const failures: FixFailure[] = [
    { at: "t1", reason: "pre-deploy-gate", prTitle: "fix: A", rootCause: "race in queue", changes: ["src/a.ts"] },
    { at: "t2", reason: "canary-unhealthy", prTitle: "fix: B", rootCause: "null deref", detail: "did not serve" },
  ];
  const out = renderFailureMemory(failures);
  assert.match(out, /do NOT repeat/i);
  assert.match(out, /fix: B/);
  assert.match(out, /null deref/);
  assert.match(out, /canary-unhealthy/);
  // most-recent-first
  assert.ok(out.indexOf("fix: B") < out.indexOf("fix: A"), "newest failure shown first");
});

test("renderFailureMemory limits how many failures it shows", () => {
  const many: FixFailure[] = Array.from({ length: 10 }, (_, i) => ({ at: `t${i}`, reason: "ci-failed" as const, prTitle: `fix ${i}` }));
  const out = renderFailureMemory(many, 3);
  assert.match(out, /fix 9/);
  assert.match(out, /fix 7/);
  assert.doesNotMatch(out, /fix 6/);
});

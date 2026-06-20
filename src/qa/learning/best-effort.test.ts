import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bestEffort, bestEffortAsync } from "./best-effort";

describe("bestEffort", () => {
  it("returns the fn result when it succeeds", () => {
    const logs: string[] = [];
    const out = bestEffort("label", (l) => logs.push(l), () => 42, -1);
    assert.equal(out, 42);
    assert.equal(logs.length, 0);
  });

  it("swallows a throw, logs once, returns the fallback", () => {
    const logs: string[] = [];
    const out = bestEffort(
      "retrieval",
      (l) => logs.push(l),
      () => {
        throw new Error("boom");
      },
      "FALLBACK",
    );
    assert.equal(out, "FALLBACK");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /retrieval/);
    assert.match(logs[0]!, /boom/);
    assert.match(logs[0]!, /non-blocking/);
  });
});

describe("bestEffortAsync", () => {
  it("swallows a rejected promise and returns the fallback", async () => {
    const logs: string[] = [];
    const out = await bestEffortAsync(
      "reflect",
      (l) => logs.push(l),
      async () => {
        throw new Error("async-boom");
      },
      null,
    );
    assert.equal(out, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /reflect/);
    assert.match(logs[0]!, /async-boom/);
    assert.match(logs[0]!, /non-blocking/);
  });

  it("returns the awaited result on success", async () => {
    const out = await bestEffortAsync("ok", () => {}, async () => "done", "fb");
    assert.equal(out, "done");
  });
});

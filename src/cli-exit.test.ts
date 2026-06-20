import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSucceeded } from "./cli-exit";

// The CLI exit-code decision. A run SUCCEEDED (exit 0) when the engine produced a trustworthy
// result — crucially INCLUDING a real bug found (`fail` → Issue), which used to exit non-zero like
// a crash. Only an engine error exits non-zero. The verdict may be a typed RunVerdict (standalone)
// or a raw wire string|null (delegated) — both normalize through the same gate.
describe("runSucceeded", () => {
  it("a real bug found (fail) is a SUCCESS — exit 0, not a process failure", () => {
    assert.equal(runSucceeded("fail"), true);
  });

  it("pass, flaky, skipped are successes", () => {
    assert.equal(runSucceeded("pass"), true);
    assert.equal(runSucceeded("flaky"), true);
    assert.equal(runSucceeded("skipped"), true);
  });

  it("invalid and infra-error are engine errors — exit non-zero", () => {
    assert.equal(runSucceeded("invalid"), false);
    assert.equal(runSucceeded("infra-error"), false);
  });

  it("a missing verdict (null/undefined) is an error — fail-safe", () => {
    assert.equal(runSucceeded(null), false);
    assert.equal(runSucceeded(undefined), false);
  });

  it("an unrecognized wire string is an error — never silently a success", () => {
    assert.equal(runSucceeded("definitely-not-a-verdict"), false);
    assert.equal(runSucceeded(""), false);
  });
});

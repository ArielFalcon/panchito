import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("parseArgs reads --base-sha", () => {
    const a = parseArgs(["--app", "x", "--sha", "bbbb222", "--base-sha", "aaaa111"]);
    assert.equal(a.baseSha, "aaaa111");
  });
});

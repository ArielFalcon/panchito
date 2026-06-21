import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStaticSignal } from "./aggregate";
const INPUT = { sha: "abc1234", repoDir: "/r", changedFiles: ["src/a.ts"], diff: "diff" };
test("aggregate returns EMPTY with a note when no supported language", async () => {
  const sig = await aggregateStaticSignal({ ...INPUT, changedFiles: ["main.go", "x.md"] }, {});
  assert.deepEqual(sig.languages, []);
  assert.match(sig.skipped.join(" "), /no changed file is in a supported language/);
});
test("aggregate isolates a throwing extractor (fail-open)", async () => {
  const sig = await aggregateStaticSignal(INPUT, {
    symbols: async () => [{ file: "src/a.ts", name: "f", kind: "function", signature: "function f()", line: 1 }],
    complexity: async () => { throw new Error("lizard missing"); },
  });
  assert.equal(sig.symbols.length, 1);
  assert.equal(sig.complexity.length, 0);
  assert.match(sig.skipped.join(" "), /complexity: lizard missing/);
});

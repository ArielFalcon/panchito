import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChange } from "@contexts/change-analysis/application/analyze-change.use-case.ts";
import type { ExtractorSet } from "@contexts/change-analysis/application/ports/index.ts";
import { ok, err } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";

const ctx = { sha: Sha.of("abc1234"), repoDir: "/repo", changedFiles: ["a.ts"], diff: "diff" };

test("aggregates extractor results into a Sha-keyed StaticSignal", async () => {
  const set: ExtractorSet = {
    symbols: { extract: async () => ok([{ file: "a.ts", name: "f", kind: "function", signature: "f()", line: 1 }]) },
  };
  const sig = await analyzeChange(ctx, set);
  assert.equal(sig.builtForSha, "abc1234");
  assert.equal(sig.symbols.length, 1);
  assert.deepEqual(sig.languages, ["typescript"]);
});

test("a degraded extractor records a TYPED ExtractorSkipped, never throws", async () => {
  const set: ExtractorSet = {
    complexity: { extract: async () => err({ extractor: "complexity", reason: "lizard missing" }) },
  };
  const sig = await analyzeChange(ctx, set);
  assert.deepEqual(sig.complexity, []);
  const skip = sig.skipped.find((s) => s.extractor === "complexity");
  assert.ok(skip !== undefined, "expected a 'complexity' skip entry");
  assert.equal(skip.reason, "lizard missing");
});

test("a THROWN extractor error is caught and recorded as a skip (fail-open, never blocks)", async () => {
  const set: ExtractorSet = {
    relations: { extract: async () => { throw new Error("boom"); } },
  };
  const sig = await analyzeChange(ctx, set);
  assert.deepEqual(sig.relations, []);
  const skip = sig.skipped.find((s) => s.extractor === "relations");
  assert.ok(skip !== undefined, "expected a 'relations' skip entry");
  assert.match(skip.reason, /boom/);
});

test("no supported-language file → records a skip and returns the empty signal", async () => {
  const sig = await analyzeChange({ ...ctx, changedFiles: ["x.rb"] }, {});
  assert.deepEqual(sig.languages, []);
  assert.equal(sig.skipped.some((s) => s.extractor === "languages"), true);
});

test("absent extractors emit 'extractor not configured' skips, not error skips", async () => {
  // CA-04: the old test name said 'no skip noise' but the assertion checks that 5 skip entries ARE
  // emitted (one per missing extractor). The rename clarifies intent: these are typed 'not configured'
  // skips (not thrown-error skips), so callers can distinguish misconfiguration from runtime failure.
  const sig = await analyzeChange(ctx, {}); // languages supported, but no extractors configured
  assert.deepEqual(sig.symbols, []);
  // one skip per missing extractor (symbols, complexity, relations, patterns, semanticDiff)
  assert.equal(sig.skipped.length, 5, "must emit one skip per unconfigured extractor, not zero");
  // every skip must use the canonical 'not configured' reason, never a thrown-error reason
  assert.equal(sig.skipped.every((s) => s.reason === "extractor not configured"), true);
});

test("PARITY: unsupported files (.rb/.py/.rs) are NEVER seen by the symbol extractor", async () => {
  // Mixed input: one supported (.ts) and one unsupported (.rb) file.
  const seenFiles: string[] = [];
  const set: ExtractorSet = {
    symbols: { extract: async (c) => { seenFiles.push(...c.changedFiles); return ok([]); } },
  };
  await analyzeChange({ ...ctx, changedFiles: ["src/app.ts", "lib/helper.rb"] }, set);
  assert.deepEqual(seenFiles, ["src/app.ts"],
    "symbol extractor must only receive supported-language files, not .rb");
});

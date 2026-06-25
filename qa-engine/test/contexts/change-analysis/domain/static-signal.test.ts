import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStaticSignal, type StaticSignal, type ExtractorSkipped } from "@contexts/change-analysis/domain/static-signal.ts";
import { Sha } from "@kernel/sha.ts";

test("emptyStaticSignal is keyed by Sha and starts empty", () => {
  const sig = emptyStaticSignal(Sha.of("abc1234"));
  assert.equal(sig.builtForSha, "abc1234");
  assert.deepEqual(sig.symbols, []);
  assert.deepEqual(sig.skipped, []);
});

test("skipped carries TYPED events, not opaque strings", () => {
  const skipped: ExtractorSkipped = { extractor: "complexity", reason: "lizard not on PATH" };
  const sig: StaticSignal = { ...emptyStaticSignal(Sha.of("abc1234")), skipped: [skipped] };
  assert.equal(sig.skipped[0]?.extractor, "complexity");
  assert.equal(sig.skipped[0]?.reason, "lizard not on PATH");
});

// test/contexts/generation/infrastructure/verdict-parser.adapter-parity.test.ts
// PARITY: VerdictParserAdapter wired to the REAL legacy parseVerdict + parseReviewerVerdict must
// produce the same output as calling the legacy functions directly. Proves the adapter is a thin
// wrap, not a reimplementation. Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
// Every test MUST fail against a gutted adapter that ignores the injected fns and hardcodes output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { parseVerdict } from "../../../../../src/integrations/verdict-parse.ts";
import { parseReviewerVerdict } from "../../../../../src/integrations/verdict-validate.ts";

// Wire the adapter to the REAL legacy parsers — no stubs.
function makeRealAdapter(): VerdictParserAdapter {
  return new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });
}

// ── parseGenerator parity ─────────────────────────────────────────────────────

test("PARITY: parseGenerator on a valid generator verdict matches legacy parseVerdict output", () => {
  const text = JSON.stringify({ specs: ["login.spec.ts", "checkout.spec.ts"], note: "all flows covered" });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const legacy = parseVerdict(text);
  // specs must match — a gutted adapter returning [] FAILS this
  assert.deepEqual(got.specs, legacy.specs ?? []);
  // parsed flag forwarded — a gutted adapter always returning parsed:true on garbage FAILS the miss test below
  assert.equal(got.parsed, legacy.parsed);
  assert.equal(got.note, legacy.note);
});

test("PARITY: parseGenerator on a parse miss is fail-closed — matches legacy parsed:false output", () => {
  const text = "the agent wrote prose with no JSON verdict";
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  const legacy = parseVerdict(text);
  // parsed:false is the legacy contract on a miss; a gutted adapter returning parsed:true FAILS this
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, legacy.parsed);
  // specs default to [] on a miss — a gutted adapter returning undefined FAILS this
  assert.deepEqual(got.specs, []);
  assert.deepEqual(got.specs, legacy.specs ?? []);
});

test("PARITY: parseGenerator with specMetas forwards them — a gutted adapter that drops specMetas FAILS", () => {
  const specMetas = [
    { file: "flows/login.spec.ts", flow: "login", objective: "user can log in", targets: ["src/auth.ts"] },
  ];
  const text = JSON.stringify({ specs: ["flows/login.spec.ts"], specMetas });
  const adapter = makeRealAdapter();
  const got = adapter.parseGenerator(text);
  // specMetas must survive the adapter — a gutted impl that drops them returns undefined here
  assert.ok(got.specMetas, "specMetas must be forwarded — a gutted adapter FAILS this");
  assert.equal(got.specMetas?.[0]?.file, "flows/login.spec.ts");
});

// ── parseReview parity ────────────────────────────────────────────────────────

test("PARITY: parseReview on a valid reviewer approval matches legacy parseReviewerVerdict output", () => {
  const text = JSON.stringify({ approved: true, rationale: "all flows exercised", corrections: [] });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  // approved forwarded — a gutted adapter always returning false FAILS this
  assert.equal(got.approved, true);
  assert.equal(got.approved, legacy.approved);
  // blockingCount forwarded — a gutted adapter returning undefined FAILS this
  assert.equal(got.blockingCount, 0);
  assert.equal(got.blockingCount, legacy.blockingCount);
  // valid forwarded — a gutted adapter dropping it returns undefined
  assert.equal(got.valid, true);
  assert.equal(got.valid, legacy.valid);
});

test("PARITY: parseReview on a reviewer rejection forwards blockingCount and corrections", () => {
  const text = JSON.stringify({
    approved: false,
    rationale: "missing assertion on discount",
    corrections: ["[false-positive] checkout.spec.ts: asserts nothing about the discount total"],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  assert.equal(got.approved, false);
  assert.equal(got.approved, legacy.approved);
  // blockingCount — the grave [false-positive] tag must make this >=1 per legacy effectiveSeverity logic
  assert.ok((got.blockingCount ?? 0) >= 1, "a grave-tagged correction must produce blockingCount >= 1");
  assert.equal(got.blockingCount, legacy.blockingCount);
});

test("PARITY: parseReview on a parse miss is fail-closed — matches legacy parsed:false output", () => {
  const text = "the reviewer wrote prose but no JSON";
  const adapter = makeRealAdapter();
  const got = adapter.parseReview(text);
  const legacy = parseReviewerVerdict(text);
  // fail-closed: approved must be false on a miss
  assert.equal(got.approved, false);
  assert.equal(got.approved, legacy.approved);
  // parsed:false forwarded — a gutted adapter that drops it returns undefined
  assert.equal(got.parsed, false);
  assert.equal(got.parsed, legacy.parsed);
  // issues forwarded — the bounded repair loop reads them; a gutted adapter returning [] loses the repair fuel
  assert.ok(Array.isArray(got.issues) && got.issues.length > 0,
    "issues must be non-empty on a parse miss — a gutted adapter FAILS this");
  assert.deepEqual(got.issues, legacy.issues);
});

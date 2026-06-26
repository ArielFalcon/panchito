// test/contexts/generation/infrastructure/verdict-parser.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";

test("parseReview delegates and forwards blockingCount + parsed + valid + issues (no behavior drop)", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, specs: ["a.spec.ts"] }) as never,
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const j = adapter.parseReview("…json…");
  assert.equal(j.approved, true);
  assert.equal(j.blockingCount, 0);   // forwarded — a port that dropped it would be undefined here
  assert.equal(j.parsed, true);       // forwarded — the parse-miss round-saver survives
  assert.equal(j.valid, true);        // forwarded — the bounded-repair signal survives
  assert.deepEqual(j.issues, []);     // forwarded — fed to repairInstruction on a contract miss
});

test("a contract-miss reviewer verdict forwards valid:false + issues (the bounded-repair re-prompt fuel)", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, specs: [] }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: [], blockingCount: 0, parsed: true, valid: false, issues: ["contract failure"] }) as never,
  } as never);
  const j = adapter.parseReview("…malformed reviewer json…");
  // valid:false != a real rejection — the use-case (B.3) fires ONE repairInstruction("reviewer", issues).
  assert.equal(j.valid, false);
  assert.deepEqual(j.issues, ["contract failure"]); // a port that dropped issues would be undefined — gutted-impl-proof
});

test("a parse MISS is fail-closed (approved:false, parsed:false) — inherited from legacy, not 'fixed'", () => {
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: false, specs: [] }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: ["no parseable verdict"], blockingCount: 0, parsed: false, valid: false, issues: ["no reviewer verdict JSON found"] }) as never,
  } as never);
  const j = adapter.parseReview("garbage");
  assert.equal(j.approved, false);
  assert.equal(j.parsed, false);
});

test("parseGenerator delegates to parseVerdict and returns specs", () => {
  let seenText = "";
  const adapter = new VerdictParserAdapter({
    parseVerdict: (text: string) => { seenText = text; return { parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok" }; },
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("verdict text");
  assert.equal(seenText, "verdict text"); // DELEGATION: a gutted impl that ignores the injected fn FAILS this
  assert.deepEqual(d.specs, ["login.spec.ts"]);
  assert.equal(d.note, "ok");
});

test("parseGenerator forwards parsed + specMetas (WRAP-2 fail-closed + WRAP-1 manifest upsert survive)", () => {
  const specMetas = [{ file: "login.spec.ts", flow: "login", objective: "sign in", targets: ["src/auth.ts"], sha256: "abc" }];
  const adapter = new VerdictParserAdapter({
    parseVerdict: () => ({ parsed: true, approved: true, specs: ["login.spec.ts"], note: "ok", specMetas }),
    parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("verdict text");
  assert.equal(d.parsed, true);                 // WRAP-2: the #1 fail-closed invariant — a port that dropped it would be undefined here
  assert.deepEqual(d.specMetas, specMetas);     // WRAP-1: drives the disk-reconciled manifest upsert — gutted-impl-proof
});

test("parseGenerator on a parse MISS is fail-closed (parsed:false, specs ?? [] = []) — GEN-05 inherited from legacy", () => {
  const adapter = new VerdictParserAdapter({
    // legacy parse miss: no verdict JSON found → parsed:false and specs absent (the ?? [] default must apply)
    parseVerdict: () => ({ parsed: false }) as never,
    parseReviewerVerdict: () => ({ approved: false, corrections: [], blockingCount: 0, parsed: false, valid: false, issues: [] }) as never,
  } as never);
  const d = adapter.parseGenerator("garbage");
  assert.equal(d.parsed, false);     // a parse miss is NOT a deliberate no-op — the use-case branches on this
  assert.deepEqual(d.specs, []);     // undefined specs default to [] (fail-closed, never undefined)
});

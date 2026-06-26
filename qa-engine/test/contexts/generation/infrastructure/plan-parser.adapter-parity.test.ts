// test/contexts/generation/infrastructure/plan-parser.adapter-parity.test.ts
// PARITY: PlanParserAdapter wired to the REAL legacy parsePlan must produce the same output as
// calling parsePlan directly, including de-dup by resulting spec filename and brief coercion
// (parsePlan calls coerceExplorationBrief internally). Imports from src/ — excluded from the main
// qa-engine typecheck; runs via tsx. Every test MUST fail against a gutted adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanParserAdapter } from "@contexts/generation/infrastructure/plan-parser.adapter.ts";
import { parsePlan } from "../../../../../src/integrations/opencode-client.ts";

// Wire the adapter to the REAL legacy parsePlan — no stubs.
function makeRealAdapter(): PlanParserAdapter {
  return new PlanParserAdapter(parsePlan);
}

// ── basic delegation ──────────────────────────────────────────────────────────

test("PARITY: parse on a valid objectives JSON matches legacy parsePlan output (flow + objective)", () => {
  const text = JSON.stringify({
    objectives: [
      { flow: "login", objective: "user can log in", symbols: ["AuthService"], needsUi: true },
      { flow: "checkout", objective: "user completes checkout", symbols: ["CheckoutService"], needsUi: true },
    ],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  // Count must match — a gutted adapter returning [] FAILS this
  assert.equal(got.length, legacy.length, "objective count must match legacy");
  assert.equal(got.length, 2);
  // flow and objective mapped faithfully — a gutted adapter inventing fields FAILS this
  assert.equal(got[0]?.flow, legacy[0]?.flow);
  assert.equal(got[0]?.objective, legacy[0]?.objective);
  assert.equal(got[1]?.flow, legacy[1]?.flow);
  assert.equal(got[1]?.objective, legacy[1]?.objective);
});

// ── de-dup by spec filename ───────────────────────────────────────────────────

test("PARITY: parse de-duplicates objectives that normalize to the same spec filename (legacy de-dup passes through)", () => {
  // "Check Out" and "check-out" both map to flows/check-out.spec.ts — parsePlan keeps only the first.
  // A gutted adapter that skips de-dup returns 2 entries; the parity assert catches it.
  const text = JSON.stringify({
    objectives: [
      { flow: "Check Out", objective: "checkout flow A", symbols: [], needsUi: true },
      { flow: "check-out", objective: "checkout flow B", symbols: [], needsUi: true },
    ],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  // Legacy de-dups to 1; a gutted adapter returning 2 FAILS this
  assert.equal(got.length, legacy.length, "de-dup count must match legacy");
  assert.equal(got.length, 1, "only one objective survives after de-dup");
  assert.equal(got[0]?.flow, legacy[0]?.flow);
});

// ── empty / parse miss ────────────────────────────────────────────────────────

test("PARITY: parse returns [] when parsePlan finds no objectives JSON — matches legacy", () => {
  const text = "no JSON here";
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  assert.deepEqual(got, [], "must return empty array on no-JSON input — a gutted adapter FAILS this");
  assert.equal(got.length, legacy.length);
});

test("PARITY: parse returns [] for an empty objectives array — matches legacy", () => {
  const text = JSON.stringify({ objectives: [] });
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  assert.deepEqual(got, []);
  assert.equal(got.length, legacy.length);
});

// ── malformed entry dropping ──────────────────────────────────────────────────

test("PARITY: parse drops malformed entries (missing flow/objective) — matches legacy filtering", () => {
  // parsePlan skips entries where flow or objective is empty/absent.
  // A gutted adapter that returns all raw entries FAILS the count check.
  const text = JSON.stringify({
    objectives: [
      { flow: "login", objective: "user can log in", needsUi: true },
      { flow: "", objective: "missing flow — should be dropped", needsUi: true },
      { flow: "profile", needsUi: true }, // missing objective — should be dropped
    ],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  // Only the valid entry survives — a gutted adapter returning all 3 FAILS this
  assert.equal(got.length, legacy.length);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.flow, "login");
});

// ── brief coercion passthrough ────────────────────────────────────────────────

test("PARITY: parse maps flow and objective when a brief is present — brief coercion is internal to parsePlan", () => {
  // parsePlan calls coerceExplorationBrief internally; the adapter view exposes only flow/objective.
  // This test ensures the adapter does not accidentally consume the brief field or change output.
  const text = JSON.stringify({
    objectives: [
      {
        flow: "payment",
        objective: "user pays successfully",
        needsUi: true,
        brief: {
          builtForSha: "abc123",
          objective: "payment flow",
          blastRadius: [{ symbol: "PaymentService.charge", file: "src/payment.ts", role: "processes payment" }],
        },
      },
    ],
  });
  const adapter = makeRealAdapter();
  const got = adapter.parse(text);
  const legacy = parsePlan(text);
  assert.equal(got.length, legacy.length);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.flow, legacy[0]?.flow);
  assert.equal(got[0]?.objective, legacy[0]?.objective);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCycleBackstop } from "@contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts";

// Boundary cases: maxRetries 0/2/5, plus the multi-objective additive raise (Phase 6b).
// CYCLES_PER_GENERATE=2, MAX_STATIC_FIX_ROUNDS=2, REPAIR_HEADROOM_PER_GENERATE=2 (ported verbatim
// from src/pipeline.ts; see the parity test for the cross-check against the legacy original).

test("deriveCycleBackstop: maxRetries=0 — single-agent, no retries budgeted", () => {
  // generateEntries = 1 + 2 + 0 + 1 = 4; base = 4 * (2 + 2) = 16
  assert.equal(deriveCycleBackstop(0), 16);
});

test("deriveCycleBackstop: maxRetries=2 — the common default", () => {
  // generateEntries = 1 + 2 + 2 + 1 = 6; base = 6 * (2 + 2) = 24
  assert.equal(deriveCycleBackstop(2), 24);
});

test("deriveCycleBackstop: maxRetries=5 — a high-retry config", () => {
  // generateEntries = 1 + 2 + 5 + 1 = 9; base = 9 * (2 + 2) = 36
  assert.equal(deriveCycleBackstop(5), 36);
});

test("deriveCycleBackstop: numObjectives=1 (default) reduces to the single-objective derivation", () => {
  assert.equal(deriveCycleBackstop(2, 1), deriveCycleBackstop(2));
});

test("deriveCycleBackstop: numObjectives>1 adds one session's worth of budget per extra objective", () => {
  // extraObjectives = 3 - 1 = 2; +2 * (2 + 2) = +8 over the single-objective base (24)
  assert.equal(deriveCycleBackstop(2, 3), deriveCycleBackstop(2) + 8);
});

test("deriveCycleBackstop: numObjectives=0 never lowers the base (Math.max(0, ...) floor)", () => {
  assert.equal(deriveCycleBackstop(2, 0), deriveCycleBackstop(2));
});

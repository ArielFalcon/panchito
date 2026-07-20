// qa-engine/test/contexts/generation/infrastructure/resilience/circuit-breaker.test.ts
// Moved from src/integrations/circuit-breaker.test.ts (migration-tier-4c Slice 2, D-4c-3) — the
// circuit breaker is SDK-free policy, so its characterization tests move with it, unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess, resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

test("circuit opens after the threshold of consecutive failures, and resetCircuit clears it", () => {
  resetCircuit();
  for (let i = 0; i < 5; i++) recordCircuitFailure();
  assert.throws(() => checkCircuit(), /circuit breaker is OPEN/);
  resetCircuit();
  assert.doesNotThrow(() => checkCircuit()); // the operator-recovery path is unblocked
});

test("a success before the threshold resets the failure streak", () => {
  resetCircuit();
  recordCircuitFailure();
  recordCircuitFailure();
  recordCircuitSuccess(); // streak broken
  recordCircuitFailure();
  recordCircuitFailure();
  assert.doesNotThrow(() => checkCircuit()); // only 2 consecutive since the success → still closed
  resetCircuit();
});

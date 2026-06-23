// Circuit breaker for the Codex transport: mirrors the OpenCode circuit breaker
// (circuit-breaker.ts) for the Codex path. If consecutive Codex failures exceed the
// threshold, the circuit opens and requests are rejected for a cooldown period —
// preventing cascading failures when the Codex provider is down or overloaded.
//
// Kept SEPARATE from the OpenCode breaker so a Codex outage never affects OpenCode
// availability and vice-versa. Same logic; separate process-global state.
//
// Usage pattern (mirrors opencode-client.ts):
//   1. Call checkCodexCircuit() at the start of every prompt call.
//   2. Call recordCodexCircuitSuccess() on a successful response.
//   3. Call recordCodexCircuitFailure() in the catch block, then re-throw.
//   4. Call resetCodexCircuit() on client disposal/restart.

let circuitFailures = 0;
let circuitOpen = false;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export function checkCodexCircuit(): void {
  if (circuitOpen) {
    const elapsed = Date.now() - circuitLastFailure;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      throw new Error(`Codex circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
    }
    circuitOpen = false;
    circuitFailures = 0;
  }
}

export function recordCodexCircuitFailure(): void {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
    console.warn(`[qa] Codex circuit breaker OPENED after ${circuitFailures} consecutive failures`);
  }
}

export function recordCodexCircuitSuccess(): void {
  if (circuitFailures > 0) {
    circuitFailures = 0;
    circuitOpen = false;
  }
}

// Clear the breaker state. Called on client disposal/restart so the operator's recovery
// action (rotate the API key → restart the provider) is not blocked by a stale OPEN
// circuit from the very failures it is meant to clear.
export function resetCodexCircuit(): void {
  circuitFailures = 0;
  circuitOpen = false;
  circuitLastFailure = 0;
}

// Circuit breaker for the OpenCode client: if consecutive failures exceed the threshold, the
// circuit opens and requests are rejected for a cooldown period — preventing cascading failures
// when the OpenCode server is down or overloaded. Extracted from opencode-client.ts (BND-08): the
// breaker is a self-contained concern (process-global state + three transitions) that the god
// module mixed in with prompt assembly, streaming and parsing.

let circuitFailures = 0;
let circuitOpen = false;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export function checkCircuit(): void {
  if (circuitOpen) {
    const elapsed = Date.now() - circuitLastFailure;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      throw new Error(`OpenCode circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
    }
    circuitOpen = false;
    circuitFailures = 0;
  }
}

export function recordCircuitFailure(): void {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
    console.warn(`[qa] OpenCode circuit breaker OPENED after ${circuitFailures} consecutive failures`);
  }
}

export function recordCircuitSuccess(): void {
  if (circuitFailures > 0) {
    circuitFailures = 0;
    circuitOpen = false;
  }
}

// Clear the breaker state. Called on client disposal/restart so the operator's recovery action
// (rotate the API key → restart the provider) is not blocked by a stale OPEN circuit from the very
// failures it is meant to clear.
export function resetCircuit(): void {
  circuitFailures = 0;
  circuitOpen = false;
  circuitLastFailure = 0;
}

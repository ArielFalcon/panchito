// qa-engine/src/contexts/generation/infrastructure/resilience/circuit-breaker.ts
// Circuit breaker for the OpenCode transport: if consecutive failures exceed the threshold, the
// circuit opens and requests are rejected for a cooldown period — preventing cascading failures
// when the OpenCode server is down or overloaded. Originally extracted from opencode-client.ts
// (BND-08) as a self-contained shell concern; migration-tier-4c Slice 2 (D-4c-3) relocates it here
// WHOLE — it is SDK-free (pure failure-count/cooldown state machine, zero @opencode-ai/sdk import),
// so per the two-tier transport split it is genuinely engine POLICY, not a raw primitive. The raw SDK
// session.create/prompt/abort calls stay shell-injected (see agent-transport-policy.ts's
// RawAgentTransport); this module is consumed by that policy layer to gate every prompt call, and by
// the shell's own client-construction retry (src/integrations/opencode-client.ts imports
// checkCircuit/recordCircuitFailure/recordCircuitSuccess/resetCircuit from here — src/ importing
// qa-engine/ is open by design, only the reverse is forbidden).
//
// Process-global state is deliberate: the breaker tracks the ONE shared OpenCode transport
// regardless of which module (shell client construction, or this engine's prompt policy) is calling
// checkCircuit/recordCircuitFailure/recordCircuitSuccess — both resolve the SAME module instance.

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

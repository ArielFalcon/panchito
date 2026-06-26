// qa-engine/src/contexts/agent-runtime/infrastructure/stall-watchdog.adapter.ts
// WRAP of src/integrations/stall-watchdog.ts createStallWatchdog behind StallWatchdogPort.
// The watchdog stays a SEPARATE port (Option B): its per-session attach/detach lifecycle is
// distinct from the breaker's retry loop and must not be coupled to it (plan §5, A.9 note).
// Injected so the test needs no real timers or clock. The watchdog factory is a plain
// (onStall) => { notify(); stop() } constructor — no network, no DB.
import type { StallWatchdogPort, AgentSession } from "../application/ports/index.ts";

/** Minimal structural shape of the legacy StallWatchdog (no src/ import at runtime). */
export interface WatchdogHandle {
  notify(): void;
  stop(): void;
}

/**
 * Factory that creates a per-session watchdog. Receives onStall (fired when the
 * session goes idle beyond the threshold) and returns a { notify, stop } handle.
 * Mirrors the signature of createStallWatchdog from src/integrations/stall-watchdog.ts.
 */
export type WatchdogFactory = (onStall: () => void) => WatchdogHandle;

export class StallWatchdogAdapter implements StallWatchdogPort {
  constructor(private readonly factory: WatchdogFactory) {}

  /**
   * Attach a new watchdog to the given session. Returns a detach fn that stops
   * the watchdog. The session arg is available for Plan-6 wiring (e.g. dispose
   * integration); the adapter does not use it directly — the wrapped factory owns
   * the lifecycle.
   */
  attach(_session: AgentSession, onStall: () => void): () => void {
    const watchdog = this.factory(onStall);
    return () => watchdog.stop();
  }
}

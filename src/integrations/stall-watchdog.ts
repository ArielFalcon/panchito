// Liveness watchdog: fires onStall if notify() is not called within stallMs.
// Fully injectable (no real clock) so unit tests run without real delays.
//
// Usage pattern:
//   const w = createStallWatchdog({ stallMs, onStall });
//   w.notify(); // called on each agent activity event to reset the timer
//   w.stop();   // called when the session ends
//
// Design: start-on-first-notify semantics — the watchdog does not arm itself
// until the first notify() call, which prevents false-positives in the window
// between construction and the agent starting work.

export interface StallWatchdogTimers {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout> | undefined) => void;
}

export interface StallWatchdogOptions {
  stallMs: number;
  onStall: () => void;
  /** Injectable timers for deterministic unit testing. Defaults to the global clock. */
  timers?: StallWatchdogTimers;
}

export interface StallWatchdog {
  /** Reset (or arm) the inactivity timer. Call on each agent activity event. */
  notify(): void;
  /** Cancel the watchdog. Safe to call multiple times. */
  stop(): void;
}

const realTimers: StallWatchdogTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function createStallWatchdog(opts: StallWatchdogOptions): StallWatchdog {
  const { stallMs, onStall } = opts;
  const timers = opts.timers ?? realTimers;

  let handle: ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopped = false;

  function arm(): void {
    timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      if (!stopped) onStall();
    }, stallMs);
  }

  return {
    notify() {
      if (stopped) return;
      arm();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(handle);
      handle = undefined;
    },
  };
}

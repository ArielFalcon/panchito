// A tiny in-process fixed-window rate limiter. Used to throttle the public POST /api/auth/login
// endpoint per client IP: that route is unauthenticated by necessity (it is how a client without
// a token obtains one), and each attempt makes outbound GitHub API calls — so an unbounded flood
// would amplify into GitHub traffic from the server's IP. This caps attempts per IP per window.
//
// Deliberately memory-only and per-process: it is a guard rail, not a distributed quota. The map
// is pruned lazily so a churn of distinct IPs cannot grow it without bound.

export interface RateLimiter {
  // allow records an attempt for `key` and returns true if it is within the window's limit,
  // false if the key has exhausted its allowance for the current window. `now` is injectable
  // (epoch ms) for deterministic tests.
  allow(key: string, now?: number): boolean;
}

interface Window {
  start: number;
  count: number;
}

const MAX_KEYS = 10_000; // prune trigger — bounds memory under a flood of distinct IPs

export function createFixedWindowLimiter(opts: { limit: number; windowMs: number }): RateLimiter {
  const { limit, windowMs } = opts;
  const windows = new Map<string, Window>();

  function prune(now: number): void {
    for (const [key, w] of windows) {
      if (now - w.start >= windowMs) windows.delete(key);
    }
  }

  return {
    allow(key: string, now = Date.now()): boolean {
      if (windows.size > MAX_KEYS) prune(now);
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      if (w.count >= limit) return false;
      w.count++;
      return true;
    },
  };
}

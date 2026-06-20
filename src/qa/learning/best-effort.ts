// In-memory fault-isolation boundary for the knowledge engine. Every engine side-effect runs
// THROUGH this wrapper so a failure is logged loudly and swallowed, never propagated into the
// pipeline. No persistence, no retry: per the engine's best-effort contract a lost outcome on a
// rare crash is acceptable; a thrown error that aborts the run is NOT.

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function bestEffort<T>(
  label: string,
  log: (line: string) => void,
  fn: () => T,
  fallback: T,
): T {
  try {
    return fn();
  } catch (err) {
    log(`[learn] ${label} failed (non-blocking): ${describe(err)}`);
    return fallback;
  }
}

export async function bestEffortAsync<T>(
  label: string,
  log: (line: string) => void,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log(`[learn] ${label} failed (non-blocking): ${describe(err)}`);
    return fallback;
  }
}

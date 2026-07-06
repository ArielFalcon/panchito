// Signal-aware sleep — resolves after `ms` OR immediately when `signal` aborts, whichever comes
// first. Used anywhere a wait must never delay cancellation by a full interval (the onboarding
// mirror-race poll loop in src/server/runner.ts is the first caller; the pattern already existed,
// module-private, in src/integrations/opencode-client.ts's sleepWithAbort — that file is owned by
// a concurrent session this change must not touch, so this is a small, deliberate duplication of
// an already-proven shape rather than a cross-cutting refactor of a live, in-flux file).

export function sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void> {
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

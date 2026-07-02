// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/abort-race.ts
// Shared helper for grounding-port adapters that wrap a collaborator with NO native AbortSignal
// support (buildContextPack / captureDom — neither generation/infrastructure primitive threads a
// signal through to its underlying Playwright render, a pre-existing legacy-parity gap; see
// pre-generation-grounding-port.adapter.ts / review-dom-grounding-port.adapter.ts headers).
//
// raceWithAbort races the collaborator's promise against the signal firing: on abort, the returned
// promise REJECTS immediately with an AbortError so the adapter's control flow unblocks promptly —
// the underlying render keeps running to its own internal timeout in the background (harmless; its
// result is simply discarded here). Killing the spawn tree itself is out of scope for these THIN
// bridge adapters (it would reach into dom-snapshot.ts's shared render internals) — tracked as a
// follow-up, not done here.

export class AbortRaceError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AbortRaceError || (err instanceof Error && err.name === "AbortError");
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortRaceError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortRaceError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

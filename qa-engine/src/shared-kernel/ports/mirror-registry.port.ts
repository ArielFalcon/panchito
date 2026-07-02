// shared-kernel/ports/mirror-registry.port.ts
// Resolves a repo identity string (e.g. "ArielFalcon/ms-name-orders") to the absolute
// filesystem path of its mirror working copy. Used by the service-topology use-case to
// map ServiceSymbolRef.repo → on-disk dir without coupling to the run's SHA or WorkspacePort.
// Phase 1: only the stub is wired; the production adapter (repo-mirror adapter) is Phase 3.
// Pattern: matches agent-runtime.port.ts / clock.port.ts — a shared-kernel port, importable via @kernel/ports/...

/** Maps a repo identity to the absolute filesystem path of its on-disk mirror working copy.
 *  mirrorDir(repo) returns the path and NEVER throws — if the repo is unknown or not yet mirrored,
 *  the adapter returns a best-effort path (stub) or throws a typed error (production).
 *  The path is NOT guaranteed to exist on disk; callers should be fail-open. */
export interface MirrorRegistryPort {
  /** Resolve a repo identity to its on-disk mirror directory (absolute path). */
  mirrorDir(repo: string): Promise<string>;
}

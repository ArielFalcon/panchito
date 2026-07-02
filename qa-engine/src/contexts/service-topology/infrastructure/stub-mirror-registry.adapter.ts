// service-topology/infrastructure/stub-mirror-registry.adapter.ts
// Phase 1 stub for MirrorRegistryPort. Returns a deterministic placeholder path
// derived from the repo identity. Behavior is unchanged — the production adapter
// (backed by the repo-mirror working copy) is Phase 3.
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

export class StubMirrorRegistryAdapter implements MirrorRegistryPort {
  /** Returns a deterministic stub path: /mirrors/{org}/{repo}.
   *  The path is NOT guaranteed to exist. Callers must be fail-open. */
  async mirrorDir(repo: string): Promise<string> {
    return `/mirrors/${repo}`;
  }
}

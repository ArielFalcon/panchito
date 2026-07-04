// service-topology/infrastructure/mirror-registry.adapter.ts
// Production MirrorRegistryPort (Phase 3): resolves a repo identity to its on-disk mirror working
// copy under mirrorRoot, using the SAME `repo.replaceAll("/","__")` encoding the repo-mirror layer
// writes with. The path is NOT guaranteed to exist — callers (ServiceLinksPortAdapter) fs-check and
// fail-open per RepoRef, matching MirrorRegistryPort's own "callers should be fail-open" contract.
// The encoding is reached ONLY through the port method (mirrorDir) — there is no static shortcut,
// so every consumer goes through the SAME injected instance (DIP honored end to end).
//
// Placed beside StubMirrorRegistryAdapter, the port's other implementation: this is that port's
// Phase-3 production impl (the stub's own header says "the production adapter … is Phase 3"),
// replacing the stub in ACTIVE composition (S2 wires it; S1 only introduces the class).
import { join } from "node:path";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

export class MirrorRegistryAdapter implements MirrorRegistryPort {
  constructor(private readonly mirrorRoot: string) {}

  /** `ArielFalcon/ms-name-orders` -> `<mirrorRoot>/ArielFalcon__ms-name-orders`. Async to satisfy
   *  MirrorRegistryPort's signature; the work itself is synchronous path-joining. */
  async mirrorDir(repo: string): Promise<string> {
    return join(this.mirrorRoot, repo.replaceAll("/", "__"));
  }
}

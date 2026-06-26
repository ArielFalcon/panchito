// qa-engine/src/contexts/generation/infrastructure/manifest-repository.adapter.ts
// WRAP of the manifest plumbing in src/integrations/opencode-client.ts (ManifestEntrySchema-validated
// read + reconcile-against-disk). The reconcile invariant (ids unique, every entry maps to an on-disk
// spec) is the LEGACY behavior — inherited via delegation, not reimplemented. Fns injected — no disk in test.
import type { ManifestRepositoryPort, ManifestEntry } from "../application/ports/index.ts";

export interface ManifestFns {
  readManifest(specDir: string): Promise<ManifestEntry[]>;
  reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

export class ManifestRepositoryAdapter implements ManifestRepositoryPort {
  constructor(private readonly fns: ManifestFns) {}

  read(specDir: string): Promise<ManifestEntry[]> {
    return this.fns.readManifest(specDir);
  }

  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
    return this.fns.reconcileManifest(specDir, entries);
  }
}

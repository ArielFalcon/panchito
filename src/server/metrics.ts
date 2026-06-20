// Prometheus metrics helpers. Extracted from index.ts so the gauge logic is
// unit-testable without starting a full HTTP server. index.ts imports and calls
// generatePrometheusMetrics() directly; nothing else should need this module.

import { join } from "node:path";
import { type AppConfig } from "../orchestrator/config-loader";

export interface ArtifactBytesDeps {
  /** Return configured app list. */
  listAppConfigs(): AppConfig[];
  /** Return the mirrors root directory. */
  mirrorRoot(): string;
  /** Compute total bytes under a directory tree (best-effort: may return 0 on error). */
  getDirectorySize(dir: string): number;
}

export interface ArtifactSizeEntry {
  name: string;
  bytes: number;
}

/** Scan every configured app's e2e/.qa/ directory and return per-app byte totals.
 *  Any scan error is caught and the app contributes 0 bytes (best-effort, never throws). */
export function collectArtifactBytes(deps: ArtifactBytesDeps): ArtifactSizeEntry[] {
  const root = deps.mirrorRoot();
  const apps = deps.listAppConfigs();
  return apps.map((app) => {
    const slug = app.repo.replaceAll("/", "__");
    const qaDir = join(root, slug, "e2e", ".qa");
    let bytes = 0;
    try {
      bytes = deps.getDirectorySize(qaDir);
    } catch {
      // best-effort: ignore scan errors
    }
    return { name: app.name, bytes };
  });
}

export interface ArtifactSizeCache {
  ts: number;
  entries: ArtifactSizeEntry[];
}

/** Build the `panchito_qa_artifact_bytes` Prometheus gauge block.
 *  Uses a TTL cache so every scrape does not trigger a full filesystem scan. */
export function buildArtifactBytesMetrics(
  deps: ArtifactBytesDeps,
  cache: { current: ArtifactSizeCache | null },
  ttlMs: number,
  now: number,
): string {
  if (!cache.current || now - cache.current.ts > ttlMs) {
    cache.current = { ts: now, entries: collectArtifactBytes(deps) };
  }
  const lines: string[] = [];
  if (cache.current.entries.length === 0) return "";
  lines.push(`# HELP panchito_qa_artifact_bytes Bytes used by .qa/ artifacts per app`);
  lines.push(`# TYPE panchito_qa_artifact_bytes gauge`);
  for (const { name, bytes } of cache.current.entries) {
    lines.push(`panchito_qa_artifact_bytes{app="${name}"} ${bytes}`);
  }
  return lines.join("\n");
}

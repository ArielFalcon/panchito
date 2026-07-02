// qa-engine/src/contexts/generation/infrastructure/manifest-fs.ts
// THE REAL, src/-FREE ManifestRepositoryPort fns — Sub-Plan 7.2 item 3 (closes the F.2 GAP,
// shadow-run.operator.ts's readManifestFile/reconcileManifestFile stopgaps).
//
// Ported verbatim from src/integrations/opencode-client.ts:
//   - realManifestFs.read (fs.read: existsSync + readFileSync, try/catch -> null on any error)
//   - upsertManifest (JSON array read, upsert-by-id merge, JSON write via mkdirSync+writeFileSync)
// The legacy pair operates on an injected ManifestFs ({ read, write }) + the legacy ManifestEntry
// shape ({ id, objective, flow, targets, changeRef, sha256 }). This module instead operates
// DIRECTLY on disk (no injected ManifestFs seam — the port itself, ManifestRepositoryPort, is the
// seam qa-engine tests inject against, matching the ManifestFns shape ManifestRepositoryAdapter
// already declares) and at the PORT's ManifestEntry shape ({ id, file, flow, objective } —
// qa-engine/.../application/ports/index.ts), which is what shadow-run.operator.ts's
// RealManifestEntry stopgap interface already matched. The upsert-by-id merge mechanic (preserve
// unrelated entries; a re-upserted id is replaced, not merged field-by-field with its old value —
// same as the real upsertManifest's `{ ...byId.get(e.id), ...e }` spread) is carried over exactly.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManifestEntry } from "../application/ports/index.ts";

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}

// Fail-open by construction, ported from realManifestFs.read: a missing file, an unreadable file,
// corrupt (non-JSON) content, or JSON that is not an array all degrade to [] — NEVER throw. This is
// load-bearing: a manifest read failure must never crash a generation run (the manifest is
// best-effort metadata, not a required input).
export async function readManifest(specDir: string): Promise<ManifestEntry[]> {
  const path = manifestPath(specDir);
  let raw: string | null;
  try {
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    raw = null;
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}

// Ported verbatim from upsertManifest's merge mechanic: read the existing array (rebuilding from []
// on a corrupt/missing file — "disk over the agent's word" only applies to WHICH entries win, not to
// crashing on a bad read), upsert the given entries by id (an existing id is REPLACED by the new
// entry, spread over any prior fields of the same id — matching `{ ...byId.get(e.id), ...e }`),
// preserve every unrelated existing entry, then write. entries.length === 0 short-circuits with NO
// write (matching upsertManifest's own early return) — a no-op reconcile never touches the manifest
// file, so it is never created just to hold an empty array.
export async function reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
  const path = manifestPath(specDir);
  if (entries.length === 0) return [];

  let existing: ManifestEntry[] = [];
  try {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as ManifestEntry[];
    }
  } catch {
    // corrupt manifest -> rebuild from the entries we have (ported verbatim from upsertManifest)
  }

  const byId = new Map<string, ManifestEntry>();
  for (const e of existing) if (e && typeof e.id === "string") byId.set(e.id, e);
  for (const e of entries) byId.set(e.id, { ...byId.get(e.id), ...e });

  const merged = [...byId.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}

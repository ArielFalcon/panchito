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
//
// migration-tier-4b Slice 2 (THE manifest reconciliation): the hand-rolled `manifestEntryViolation`
// twin (a duplicate, already-drifted re-enforcement of src/orchestrator/schemas.ts's
// ManifestEntrySchema) is REPLACED by the canonical `@kernel/manifest/manifest-entry.ts` validator —
// ONE schema, shared by this write path AND the read-path static gate (checkManifest, via
// metadata.ts). `ManifestEntry` (application/ports/index.ts) is now a re-export of the canonical
// type: `targets`/`changeRef` are REQUIRED (closing the latent type/runtime mismatch), `file` stays
// OPTIONAL (a pre-4b/hand-edited entry lacking it must not be rejected).
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ManifestEntry } from "../application/ports/index.ts";
import { manifestEntryViolation } from "@kernel/manifest/manifest-entry.ts";

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}

// Ported verbatim from src/integrations/opencode-client.ts's sha256File: content checksum of a spec
// file, computed for integrity verification AND (per reconcileManifest below) doubling as the
// on-disk existence probe — a file that cannot be read (absent, unreadable, any fs error) yields
// undefined rather than throwing, matching the legacy fail-open contract.
function sha256File(path: string): string | undefined {
  try {
    const data = readFileSync(path);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
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

// Ported verbatim from opencode-client.ts:764-810's two safety passes, run BEFORE the upsert-merge
// (legacy drops before writing — same ordering here): (1) the sha256 presence filter — a specMeta
// naming a `file` that is NOT readable on disk is a PHANTOM (the agent claimed a spec it never
// wrote); dropped with a console.warn, never silently. A present file always yields a sha256, so
// this pass doubles as the "disk over the agent's word" existence check AND stamps the entry with
// its integrity checksum (mirrors legacy's `sha256: sha256!` — persisted on the surviving entry).
// (2) structural validation against the same shape the real read-path schema enforces — an entry
// that passes the disk check but is malformed (empty objective/targets/etc.) is dropped with a
// console.warn too, never corrupting the manifest. Both passes are loud (CLAUDE.md: never swallow
// silently), matching legacy's console.warn-per-drop behavior exactly.
//
// migration-tier-4b Slice 2: `file` is now OPTIONAL on the canonical ManifestEntry (a pre-4b or
// hand-edited entry may legitimately declare no file). The disk-existence check must distinguish
// "file declared but NOT on disk" (a real phantom — drop it) from "no file declared at all" (not a
// phantom — keep it, sha256 stays undefined, never fabricated). Collapsing both into "no sha256 ⇒
// drop" (the pre-Slice-2 shape, where `file` was type-required so this distinction never mattered)
// would now falsely flag every file-less entry as a phantom.
function safetyFilter(specDir: string, entries: readonly ManifestEntry[]): ManifestEntry[] {
  const withSha = entries.map((e) => {
    if (!e.file) return { e, sha256: undefined, phantom: false }; // no file declared — not a phantom
    const sha256 = sha256File(join(specDir, e.file));
    return { e, sha256, phantom: sha256 === undefined };
  });
  const onDisk = withSha
    .filter(({ e, phantom }) => {
      if (phantom) {
        console.warn(`[qa] WARNING: agent reported spec '${e.file}' in its manifest metadata but it is not on disk — dropping the phantom manifest entry.`);
        return false;
      }
      return true;
    })
    .map(({ e, sha256 }) => (sha256 !== undefined ? { ...e, sha256 } : e));

  return onDisk.filter((e) => {
    const violation = manifestEntryViolation(e);
    if (violation) {
      console.warn(`[qa] WARNING: dropping manifest entry '${e.id}' — it fails the manifest schema: ${violation}.`);
      return false;
    }
    return true;
  });
}

// Ported verbatim from upsertManifest's merge mechanic: read the existing array (rebuilding from []
// on a corrupt/missing file — "disk over the agent's word" only applies to WHICH entries win, not to
// crashing on a bad read), upsert the given entries by id (an existing id is REPLACED by the new
// entry, spread over any prior fields of the same id — matching `{ ...byId.get(e.id), ...e }`),
// preserve every unrelated existing entry, then write. entries.length === 0 short-circuits with NO
// write (matching upsertManifest's own early return) — a no-op reconcile never touches the manifest
// file, so it is never created just to hold an empty array. Entries are run through safetyFilter
// (phantom-drop + structural validation) BEFORE the merge, matching legacy's drop-before-write order.
export async function reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
  const path = manifestPath(specDir);
  if (entries.length === 0) return [];

  const safeEntries = safetyFilter(specDir, entries);
  if (safeEntries.length === 0) return [];

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
  for (const e of safeEntries) byId.set(e.id, { ...byId.get(e.id), ...e });

  const merged = [...byId.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}

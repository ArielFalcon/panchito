// qa-engine/src/shared-kernel/manifest/manifest-entry.ts
// THE canonical per-test manifest-entry shape (e2e/.qa/manifest.json), migration-tier-4b Slice 2 —
// THE MANIFEST RECONCILIATION. Before this slice, two INDEPENDENTLY validated shapes existed for
// the SAME file: "Shape A" (src/orchestrator/schemas.ts's ManifestEntrySchema, a zod schema — what
// the static gate's read-path `checkManifest` enforced, historically via the now-deleted
// src/qa/metadata.ts::validateManifest; post-tier-4b it delegates to THIS module's validateManifest)
// and "Shape B" (qa-engine's own generation/application/ports/index.ts ManifestEntry — a bare TS
// interface, RE-ENFORCED at runtime by manifest-fs.ts's hand-rolled `manifestEntryViolation`, an
// independently-maintained, already-drifted twin of Shape A's requiredness). This module collapses
// both into ONE canonical zod schema, reused by BOTH consumption sites — never a third shape.
//
// UNION, not a lossy intersection: retains `file` (Shape B's field — load-bearing for
// manifest-fs.ts's on-disk phantom check) AND every field Shape A enforces or accepts (useCase/
// criticality/owner/createdAt/coverage/sensitivity/stability/ledger/merit). `file` is OPTIONAL
// (`.min(1).optional()`) — Shape A's read gate never required it; requiring it now would REJECT
// pre-4b/hand-edited entries, a forbidden widening. `targets`/`changeRef` are REQUIRED at BOTH the
// type and the runtime-check level (closing the latent bug: Shape B's TYPE declared them optional
// while Shape A's runtime check already required them — the type now matches the runtime).
//
// qa-engine/src stays src/-free by construction: this schema lives in the KERNEL (no src/ import),
// and src/orchestrator/schemas.ts's ManifestEntrySchema/ManifestSchema/ValidatedManifestEntry become
// THIN RE-EXPORTS of this module (shell -> qa-engine is the open direction; see
// qa-engine/.dependency-cruiser.cjs's own "no-src-import-in-qa-engine" rule comment).

import { z } from "zod";

export const ManifestEntrySchema = z.object({
  id: z.string().min(1, { error: "manifest entry missing 'id'" }),
  objective: z.string().min(1, { error: "manifest entry missing 'objective'" }),
  flow: z.string().min(1, { error: "manifest entry missing 'flow'" }),
  useCase: z.string().optional(),
  // The qa-engine port's field (generation writes it from the agent's SpecMeta.file). Load-bearing
  // for manifest-fs.ts's write-path on-disk phantom check (safetyFilter's sha256 verification) —
  // OPTIONAL so a pre-4b or hand-edited entry lacking it is never rejected by the schema itself
  // (manifest-fs.ts's own degrade branch handles the "no file declared" case explicitly; see that
  // file's own header note).
  file: z.string().min(1).optional(),
  targets: z.array(z.string()).min(1, { error: "manifest entry has empty 'targets'" }),
  changeRef: z.object({
    sha: z.string().min(1),
    type: z.string().min(1),
    pr: z.number().optional(),
    ticket: z.string().optional(),
  }),
  // Content checksum of the spec file, written by the orchestrator at manifest time for integrity
  // verification. Declared here (optional) so the schema matches what the write path actually emits
  // and the read path preserves it instead of silently stripping it.
  sha256: z.string().optional(),
  criticality: z.enum(["critical", "normal"]).optional(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
  coverage: z
    .object({
      files: z.array(z.string()).optional(),
      functions: z.array(z.string()).optional(),
    })
    .optional(),
  sensitivity: z
    .object({
      status: z.enum(["pass", "fail", "unknown"]),
      method: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
  stability: z
    .object({
      runs: z.number(),
      flakyRuns: z.number(),
    })
    .optional(),
  ledger: z
    .object({
      caughtRegressions: z.number(),
      falsePositives: z.number(),
    })
    .optional(),
  merit: z.number().optional(),
});

export const ManifestSchema = z.array(ManifestEntrySchema);

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

function formatZodIssue(issue: { path: PropertyKey[]; message: string }): string {
  const tag = issue.path.length > 0 ? `entry ${issue.path.join(".")}` : "manifest";
  return `${tag}: ${issue.message}`;
}

// Array-shape validator — structural/field validation only; duplicate-id detection is a
// READ-GATE-specific concern layered on top by the caller, since the write path's upsert-by-id
// merge structurally cannot produce duplicates. Filter B's checkManifest
// (qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts) calls THIS function
// directly for the structural check and layers its own duplicate-id check on top — the ONE
// canonical validator, reused at both consumption sites (this array check and
// manifestEntryViolation's single-entry write-time check below), with no reimplemented copy.
export function validateManifest(raw: unknown): ManifestValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["the manifest (e2e/.qa/manifest.json) must be an array"] };
  }
  const result = ManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, errors: [] };
  return { ok: false, errors: result.error.issues.map(formatZodIssue) };
}

// Single-entry violation check — the canonical replacement for manifest-fs.ts's hand-rolled
// manifestEntryViolation (a hand-written twin of Shape A's requiredness that had already diverged:
// it never validated the optional fields' TYPES, e.g. a malformed criticality:"urgent" would pass
// the old write-time check but fail the read-time zod check on the very next Filter B run). Used at
// WRITE time only (reconcile's safetyFilter, one entry at a time) — returns the first violation
// message, or undefined when the entry is well-formed.
export function manifestEntryViolation(e: unknown): string | undefined {
  const result = ManifestEntrySchema.safeParse(e);
  if (result.success) return undefined;
  return result.error.issues[0]?.message ?? "invalid manifest entry";
}

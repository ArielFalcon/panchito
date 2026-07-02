// Difftastic extractor — cosmetic vs. real semantic change per file.
//
// Ported from src/qa/static-signal/semantic-diff.ts (Plan 7.3 §2 — sever the qa-engine→src/
// import edge): same behavior, byte-for-byte, using the local runbinary.ts + the already-ported
// scrub-env.ts (Plan 7.2) instead of the legacy exec.ts + code-runner.ts.
//
// difft 0.69.0 invocation: two-file mode via temp blobs materialized from git.
// Base ref = baseSha ?? `${sha}^` (single-commit fallback: parent commit; documented).
// The tool requires DFT_UNSTABLE=yes to emit JSON. Output is NDJSON — one JSON
// object per line. Each object carries a `status` field:
//   "unchanged" — the diff was purely cosmetic (whitespace/comment-only); no AST change.
//   "changed"   — there is a real semantic difference; the `chunks` array is non-empty.
// This is the signal we key off. A file with status:"unchanged" → cosmetic:true.

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { FileChangeKind } from "../../domain/static-signal.ts";
import { runBinary } from "./runbinary.ts";
import { scrubEnv } from "../../../../shared-infrastructure/process-sandbox/scrub-env.ts";

// ── NDJSON record types (difft 0.69.0) ───────────────────────────────────────

interface DifftRecord {
  status: "unchanged" | "changed" | "added" | "removed";
  path: string;
  language?: string;
  // chunks is present (and non-empty) only when status is "changed"
  chunks?: unknown[];
}

// ── Parser (unit-tested) ──────────────────────────────────────────────────────

// Parses NDJSON output from `difft --display json` (DFT_UNSTABLE=yes required).
// Each non-empty line is one JSON record. A record with status:"unchanged" means
// the diff was purely cosmetic (whitespace/comment). Any other status — "changed",
// "added", "removed" — is treated as non-cosmetic (a real semantic difference).
// Returns FileChangeKind[] keyed by the `path` field from the record.
export function parseDifftJson(json: string): FileChangeKind[] {
  const result: FileChangeKind[] = [];
  for (const raw of json.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // skip malformed lines gracefully
    }
    if (!isDifftRecord(record)) continue;
    result.push({ file: record.path, cosmetic: record.status === "unchanged" });
  }
  return result;
}

function isDifftRecord(value: unknown): value is DifftRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "path" in value &&
    typeof (value as Record<string, unknown>).status === "string" &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}

// ── Git blob helpers ──────────────────────────────────────────────────────────

// Materialise a git object (ref:path) into a temp file. Returns the temp path
// on success, or null when the object does not exist at this ref (added/deleted).
function materializeBlob(ref: string, filePath: string, repoDir: string): string | null {
  const tmp = join(tmpdir(), `difft-${randomUUID()}`);
  try {
    const content = execFileSync("git", ["show", `${ref}:${filePath}`], { cwd: repoDir, env: scrubEnv() });
    writeFileSync(tmp, content);
    return tmp;
  } catch {
    // Object doesn't exist at this ref (added/deleted file) — caller skips gracefully.
    return null;
  }
}

// Extract changed (modified) file paths from a unified diff's `--- a/` / `+++ b/` headers.
// Skips pure additions (no `--- a/`) and pure deletions (no `+++ b/` pointing at b/).
// Returns repo-relative POSIX paths for files that exist on both sides (modified).
function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  let basePath: string | null = null;
  let headPath: string | null = null;
  let afterDiffGit = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Flush the previous file pair (modified = both sides present).
      if (basePath !== null && headPath !== null) files.push(headPath);
      afterDiffGit = true;
      basePath = null;
      headPath = null;
      continue;
    }
    if (!afterDiffGit) continue;
    if (line.startsWith("--- a/")) {
      basePath = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      headPath = line.slice(6).trim();
      continue;
    }
    // Once we see a hunk marker, we're done parsing headers for this file.
    if (line.startsWith("@@")) afterDiffGit = false;
  }
  // Flush the last file pair.
  if (basePath !== null && headPath !== null) files.push(headPath);
  return files;
}

// ── Runner ────────────────────────────────────────────────────────────────────

// Runs difft (AST-aware) on each changed file in the diff and classifies the
// result as cosmetic (whitespace/comment-only) or real (semantic change).
//
// baseSha defaults to `${sha}^` — the parent commit — when not provided. This
// covers the common single-commit diff case. For PRs or range diffs, callers
// should always pass the explicit baseSha (the PR base SHA) so the comparison
// is against the right ancestor rather than the immediate parent.
//
// Degrades gracefully to [] when:
//   - difft is not on PATH (code === null from runBinary)
//   - a file only exists on one side (added/deleted) — skipped per-file
//   - any other error per file — skipped; the aggregator records "skipped"
export async function extractSemanticDiff(
  diff: string,
  repoDir: string,
  sha: string,
  baseSha?: string,
): Promise<FileChangeKind[]> {
  const baseRef = baseSha ?? `${sha}^`;
  const headRef = sha;
  const changedFiles = changedFilesFromDiff(diff);
  if (changedFiles.length === 0) return [];

  const results: FileChangeKind[] = [];

  for (const filePath of changedFiles) {
    let tmpBase: string | null = null;
    let tmpHead: string | null = null;
    try {
      tmpBase = materializeBlob(baseRef, filePath, repoDir);
      tmpHead = materializeBlob(headRef, filePath, repoDir);

      // If either side is missing, this is a pure add or delete — skip.
      if (tmpBase === null || tmpHead === null) continue;

      const result = await runBinary(
        "difft",
        ["--display", "json", tmpBase, tmpHead],
        repoDir,
        60_000,
        { DFT_UNSTABLE: "yes" },
      );

      if (result.code === null) {
        // Tool missing or timed out — degrade to empty for this file.
        continue;
      }

      const parsed = parseDifftJson(result.stdout);
      // The path in difft's output is the absolute temp file path; remap to the
      // repo-relative path so callers get consistent file identifiers.
      for (const entry of parsed) {
        results.push({ file: filePath, cosmetic: entry.cosmetic });
      }
    } finally {
      // Always clean up temp files, even if an error was thrown above.
      if (tmpBase !== null) rmSync(tmpBase, { force: true });
      if (tmpHead !== null) rmSync(tmpHead, { force: true });
    }
  }

  return results;
}

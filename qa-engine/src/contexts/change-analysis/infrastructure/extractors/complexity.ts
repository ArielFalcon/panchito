// Cyclomatic complexity extractor — lizard 1.23.0, invoked as `python3 -m lizard`.
//
// Ported from src/qa/static-signal/complexity.ts (Plan 7.3 §2 — sever the qa-engine→src/ import
// edge): same behavior, byte-for-byte, using the local runbinary.ts (over qa-engine's
// SandboxedBinaryRunnerAdapter) instead of the legacy exec.ts, and a locally-kept normalizeRepoPath
// instead of importing it from ../change-coverage — mirrors the same local-copy pattern already
// used by lcov-coverage.adapter.ts / c8-coverage.adapter.ts (Plan 7.2) to keep this adapter
// self-contained.
//
// lizard CSV format (no header row, 11 columns):
//   col[0]=nloc, col[1]=ccn, col[2]=token_count, col[3]=param_count, col[4]=length,
//   col[5]="fn@start-end@/abs/path" (quoted), col[6]="/abs/file" (quoted),
//   col[7]=function_name (quoted), col[8]=long_name (quoted),
//   col[9]=start_line, col[10]=end_line
//
// Only hotspots (ccn >= 5) are returned. Files with no hotspots emit nothing.
// Degrades cleanly to [] when lizard is missing (code===null from runBinary).

import { isAbsolute, relative } from "node:path";
import type { ComplexityHotspot } from "../../domain/static-signal.ts";
import { runBinary } from "./runbinary.ts";

const CCN_THRESHOLD = 5;

// Verbatim-carried from change-coverage.ts's normalizeRepoPath. Coverage/complexity reports use
// absolute or tool-relative paths; the diff uses repo-relative. Normalize everything to
// repo-relative POSIX so the two sides intersect on the same keys.
function normalizeRepoPath(p: string, repoDir?: string): string {
  let out = p.replace(/\\/g, "/").trim();
  if (repoDir) {
    const root = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (isAbsolute(out) && out.startsWith(root + "/")) out = out.slice(root.length + 1);
    else if (isAbsolute(out)) {
      const rel = relative(repoDir, p).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) out = rel;
    }
  }
  return out.replace(/^\.\//, "").replace(/^\/+/, "");
}

// Strip surrounding double-quotes from a CSV field if present.
function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

// Split a lizard CSV line into exactly 11 raw fields.
// lizard quoting is simple: quoted fields contain no embedded quotes or commas,
// so a straightforward comma split works — but we must not split inside "..."
// to handle the location field (col[5]) which contains "@" separators, not commas.
// The location field is the only quoted field that could contain commas, but lizard's
// location is "fn@start-end@/path" — no commas inside — so a plain split is safe.
function splitCsvLine(line: string): string[] | null {
  // lizard emits lines with quoted fields: parse respecting double-quote boundaries.
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field — find closing quote (lizard does not escape inner quotes).
      const close = line.indexOf('"', i + 1);
      if (close === -1) return null; // malformed
      fields.push(line.slice(i, close + 1)); // keep quotes, stripped later
      i = close + 1;
      if (i < line.length && line[i] === ",") i++; // consume comma
    } else {
      // Unquoted field — read until comma or end of line.
      const comma = line.indexOf(",", i);
      if (comma === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, comma));
        i = comma + 1;
      }
    }
  }
  return fields.length >= 11 ? fields : null;
}

// Parse lizard CSV output (no header row) into ComplexityHotspot[]. Paths are normalized relative
// to repoDir so the signal joins on the same keys used by other static-signal extractors.
export function parseLizardCsv(csv: string, repoDir: string): ComplexityHotspot[] {
  const hotspots: ComplexityHotspot[] = [];
  for (const raw of csv.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const fields = splitCsvLine(line);
    if (!fields) continue; // malformed — skip, never throw

    const nloc = Number(stripQuotes(fields[0]!));
    const ccn = Number(stripQuotes(fields[1]!));
    const file = normalizeRepoPath(stripQuotes(fields[6]!), repoDir);
    const fnName = stripQuotes(fields[7]!);
    const startLine = Number(stripQuotes(fields[9]!));

    if (!Number.isFinite(nloc) || !Number.isFinite(ccn) || !Number.isFinite(startLine)) continue;
    if (ccn < CCN_THRESHOLD) continue; // not a hotspot

    hotspots.push({ file, function: fnName, ccn, nloc, line: startLine });
  }
  return hotspots;
}

// Run lizard over the given absolute file paths and return complexity hotspots.
// Uses `python3 -m lizard` — the lizard binary is not on PATH; it is a Python module.
// Returns [] when:
//   - files is empty (guard: no spawn needed)
//   - lizard/python3 is missing (runBinary returns code===null)
//   - lizard finds no functions above the threshold
export async function extractComplexity(
  files: string[],
  repoDir: string,
): Promise<ComplexityHotspot[]> {
  if (files.length === 0) return [];

  const result = await runBinary("python3", ["-m", "lizard", "--csv", ...files], repoDir);
  if (result.code === null) return [];

  return parseLizardCsv(result.stdout, repoDir);
}

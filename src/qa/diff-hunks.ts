// src/qa/diff-hunks.ts
//
// Pure, dependency-free diff/path primitives shared by src/qa/changed-elements.ts and
// src/qa/static-signal/complexity.ts. Extracted here after Plan 7.6 deleted src/pipeline.ts and
// its legacy-only src/qa/change-coverage.ts (the objective-signal keystone, now owned exclusively
// by qa-engine's contexts/objective-signal/domain/{assemble-change-coverage,decide-coverage.service}.ts
// — see that context for coverage measurement, decision policy, and report parsing).
//
// parseDiffHunks/normalizeRepoPath were NOT legacy-only: they are consumed by two still-live src/qa/
// grounding modules (changed-elements.ts's blast-radius extraction, static-signal/complexity.ts's
// path normalization), which have nothing to do with coverage measurement or PipelineDeps. Deleting
// change-coverage.ts wholesale would have broken those; this module is the surgical, root-cause fix
// — carry forward only the genuinely-shared pure functions, not the deleted pipeline's coverage
// machinery.

import { isAbsolute, relative } from "node:path";

// file (repo-relative, POSIX) → set of line numbers (1-based, new-file side for the diff).
export type CoveredLines = Map<string, Set<number>>;

// ── Path normalization ───────────────────────────────────────────────────────
// Coverage reports use absolute or tool-relative paths; the diff uses repo-relative. Normalize
// everything to repo-relative POSIX so the two sides intersect on the same keys.
export function normalizeRepoPath(p: string, repoDir?: string): string {
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

// ── Diff → changed lines (pure) ──────────────────────────────────────────────
// Returns the ADDED/modified lines per file, numbered on the NEW side (which matches the working
// copy checked out at the SHA, i.e. what coverage reports against). Pure deletions contribute no
// new lines (a removed line cannot be "covered"), so such files simply do not appear.
export function parseDiffHunks(diff: string): CoveredLines {
  const changed: CoveredLines = new Map();
  let file: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    // A new file section always resets hunk state — so `+++ `/`--- ` are only ever read as headers
    // here (before any `@@`), never confused with a hunk CONTENT line that happens to start with
    // "+++ " or "--- " (e.g. a diff snippet added to a markdown file).
    if (raw.startsWith("diff --git")) {
      file = null;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // pre-hunk header lines: only `+++ <new path>` matters (set the file); ignore the rest.
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).trim();
        file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
      }
      continue;
    }
    if (file === null) continue; // inside a hunk of a deleted file (+++ /dev/null): no new lines
    const c = raw[0];
    if (c === "+") {
      let set = changed.get(file);
      if (!set) changed.set(file, (set = new Set()));
      set.add(newLine);
      newLine++;
    } else if (c === "-") {
      // old side only — does not advance the new-file counter
    } else if (c === "\\") {
      // "\ No newline at end of file" — ignore
    } else {
      // context line (starts with a space, or an empty line within the hunk)
      newLine++;
    }
  }
  return changed;
}

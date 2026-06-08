// THE VALUE KEYSTONE — change-coverage.
//
// The harness proves a test runs GREEN; it does not prove the test COVERS the change. This
// module measures, deterministically, whether executing the generated tests actually exercises
// the lines the commit changed — the first ground-truth signal that breaks the circular
// "LLM-judges-LLM" quality loop (see CLAUDE.md "The value/trust risk").
//
// Design (app-agnostic, tiered, fail-safe):
//  - The CORE is pure and fully unit-tested: parse the diff into changed lines, parse a coverage
//    report into covered lines, intersect, decide. It knows nothing about how coverage is obtained.
//  - COVERAGE PROVIDERS (the injected boundary) obtain covered lines per target: native reports
//    (lcov / Istanbul) for code mode, V8 browser dumps for e2e. Absence of a usable report →
//    `null` → status "unknown", which NEVER blocks (determinism over zeal).
//  - The POLICY (off | signal | enforce) decides what a low ratio DOES: signal records + feeds
//    the reviewer; enforce additionally blocks publishing. Default is signal.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { TestTarget } from "../types";

// file (repo-relative, POSIX) → set of line numbers (1-based, new-file side for the diff).
export type CoveredLines = Map<string, Set<number>>;

export type CoverageStatus = "pass" | "fail" | "unknown";
export type CoverageMode = "off" | "signal" | "enforce";

export interface ChangeCoveragePolicy {
  mode: CoverageMode;
  minRatio: number; // [0,1] — the fraction of changed lines that must be covered to "pass"
}

export const DEFAULT_COVERAGE_POLICY: ChangeCoveragePolicy = { mode: "signal", minRatio: 0.7 };

export interface ChangeCoverage {
  measured: boolean; // false when no changed file had any coverage data (→ "unknown")
  overall: { changedLines: number; coveredChanged: number; ratio: number };
  perFile: Array<{ file: string; changed: number; covered: number; ratio: number }>;
  uncovered: Array<{ file: string; lines: number[] }>; // changed lines NOT exercised
}

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

// ── Intersection (pure) ──────────────────────────────────────────────────────
export function computeChangeCoverage(changed: CoveredLines, covered: CoveredLines): ChangeCoverage {
  const perFile: ChangeCoverage["perFile"] = [];
  const uncovered: ChangeCoverage["uncovered"] = [];
  let totalChanged = 0;
  let totalCovered = 0;
  let anyFileMeasured = false;

  for (const [file, lines] of changed) {
    const cov = covered.get(file);
    if (cov) anyFileMeasured = true;
    let fileCovered = 0;
    const fileUncovered: number[] = [];
    for (const ln of lines) {
      if (cov?.has(ln)) fileCovered++;
      else fileUncovered.push(ln);
    }
    totalChanged += lines.size;
    totalCovered += fileCovered;
    perFile.push({ file, changed: lines.size, covered: fileCovered, ratio: lines.size ? fileCovered / lines.size : 1 });
    if (fileUncovered.length) uncovered.push({ file, lines: fileUncovered.sort((a, b) => a - b) });
  }

  return {
    measured: anyFileMeasured,
    overall: { changedLines: totalChanged, coveredChanged: totalCovered, ratio: totalChanged ? totalCovered / totalChanged : 1 },
    perFile,
    uncovered,
  };
}

// ── Decision (pure) ──────────────────────────────────────────────────────────
// The quality STATUS (independent of what the policy does about it). Unmeasured → "unknown",
// which never blocks. The mode (signal/enforce) is applied by the caller.
export function decideCoverage(cc: ChangeCoverage | null, policy: ChangeCoveragePolicy): CoverageStatus {
  if (!cc || !cc.measured || cc.overall.changedLines === 0) return "unknown";
  return cc.overall.ratio >= policy.minRatio ? "pass" : "fail";
}

// Whether an "enforce" policy should BLOCK publishing for this status.
export function blocksPublish(status: CoverageStatus, policy: ChangeCoveragePolicy): boolean {
  return policy.mode === "enforce" && status === "fail";
}

// A compact, human/agent-readable summary of what was NOT covered (for the reviewer + Issues).
export function renderUncovered(cc: ChangeCoverage, max = 10): string {
  if (cc.uncovered.length === 0) return "all changed lines are covered by the tests";
  const lines = cc.uncovered
    .slice(0, max)
    .map((u) => `- ${u.file}: lines ${compactRanges(u.lines)}`);
  const more = cc.uncovered.length > max ? `\n…and ${cc.uncovered.length - max} more file(s)` : "";
  return `changed lines NOT exercised by any test (ratio ${(cc.overall.ratio * 100).toFixed(0)}%):\n${lines.join("\n")}${more}`;
}

function compactRanges(sorted: number[]): string {
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (n !== undefined) start = prev = n;
  }
  return parts.join(", ");
}

// ── Report parsers (pure) ────────────────────────────────────────────────────

// lcov (the lingua franca: c8, nyc, jest, coverage.py `lcov`, JaCoCo plugins all emit it).
//   SF:<path>  DA:<line>,<hits>  …  end_of_record
export function parseLcov(text: string, repoDir?: string): CoveredLines {
  const out: CoveredLines = new Map();
  let file: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = normalizeRepoPath(line.slice(3).trim(), repoDir);
      if (!out.has(file)) out.set(file, new Set());
    } else if (line.startsWith("DA:") && file) {
      const [lnStr, hitsStr] = line.slice(3).split(",");
      const ln = Number(lnStr);
      const hits = Number(hitsStr);
      if (Number.isFinite(ln) && hits > 0) out.get(file)!.add(ln);
    } else if (line.startsWith("end_of_record")) {
      file = null;
    }
  }
  return out;
}

// Istanbul coverage-final.json (Node default from c8/nyc): { "<path>": { statementMap, s } }.
export function parseIstanbulJson(json: unknown, repoDir?: string): CoveredLines {
  const out: CoveredLines = new Map();
  if (!json || typeof json !== "object") return out;
  for (const [rawPath, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { path?: string; statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>; s?: Record<string, number> };
    const file = normalizeRepoPath(e.path ?? rawPath, repoDir);
    const set = new Set<number>();
    const map = e.statementMap ?? {};
    const counts = e.s ?? {};
    for (const [id, stmt] of Object.entries(map)) {
      if ((counts[id] ?? 0) <= 0) continue;
      const from = stmt.start?.line;
      const to = stmt.end?.line ?? from;
      if (typeof from === "number" && typeof to === "number") for (let l = from; l <= to; l++) set.add(l);
    }
    if (set.size) out.set(file, set);
  }
  return out;
}

// V8 coverage (Chromium, what the e2e seed fixture dumps). Each entry: { url, source, functions:
// [{ ranges: [{ startOffset, endOffset, count }] }] }. Covered byte ranges (count>0) are mapped to
// source line numbers via the script text. URLs are resolved to repo files by longest path suffix
// against the changed files (so an unbundled dev server's /src/Foo.tsx maps to src/Foo.tsx). When a
// changed file matches no script, it is simply unmeasured (→ does not falsely count as covered).
interface V8Entry {
  url?: string;
  source?: string;
  functions?: Array<{ ranges?: Array<{ startOffset: number; endOffset: number; count: number }> }>;
}
export function parseV8Coverage(entries: V8Entry[], changedFiles: string[]): CoveredLines {
  const out: CoveredLines = new Map();
  for (const entry of entries) {
    if (!entry?.source || !entry.url) continue;
    const file = resolveUrlToRepoFile(entry.url, changedFiles);
    if (!file) continue;
    const source = entry.source;

    // Resolve NESTED ranges to per-byte coverage. V8 emits ranges parent-before-child,
    // so applying each range's count over its span in order leaves every byte with its
    // INNERMOST range's count: a count==0 child carves an uncovered hole out of a covered
    // parent. (The old code unioned only count>0 ranges, so a function-wrapper range marked
    // an unexercised branch covered — over-reporting that could flip a real gap to a pass.)
    const covered = new Uint8Array(source.length);
    for (const fn of entry.functions ?? []) {
      for (const r of fn.ranges ?? []) {
        const start = Math.max(0, r.startOffset);
        const end = Math.min(source.length, r.endOffset);
        const val = r.count > 0 ? 1 : 0;
        for (let i = start; i < end; i++) covered[i] = val;
      }
    }

    // A line is covered if ANY of its bytes ended up covered.
    const lineStarts = lineStartOffsets(source);
    const set = out.get(file) ?? new Set<number>();
    for (let ln = 0; ln < lineStarts.length; ln++) {
      const from = lineStarts[ln]!;
      const to = ln + 1 < lineStarts.length ? lineStarts[ln + 1]! : source.length;
      for (let i = from; i < to; i++) {
        if (covered[i]) {
          set.add(ln + 1);
          break;
        }
      }
    }
    if (set.size) out.set(file, set);
  }
  return out;
}

// Match a script URL to one of the changed repo files by the longest shared path suffix.
export function resolveUrlToRepoFile(url: string, changedFiles: string[]): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  path = path.replace(/\\/g, "/").replace(/^\/+/, "");
  let best: string | null = null;
  let bestLen = 0;
  for (const f of changedFiles) {
    const nf = f.replace(/\\/g, "/");
    // a script path matches a repo file if one is a path-suffix of the other
    if (path === nf || path.endsWith("/" + nf) || nf.endsWith("/" + path)) {
      const len = Math.min(path.length, nf.length);
      if (len > bestLen) {
        best = f;
        bestLen = len;
      }
    }
  }
  return best;
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}
// Binary search: 1-based line number containing the byte offset.
function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ── Default provider (the injected boundary) ─────────────────────────────────
// Reads coverage produced by the run from conventional locations — NON-invasively (it never
// changes how the suite runs). Returns null when nothing usable is found (→ "unknown").
export interface CoverageCollectInput {
  target: TestTarget;
  repoDir: string;
  e2eDir: string;
  changedFiles: string[];
  namespace: string; // run-scoped (qa-bot-<sha>): isolates this run's browser dumps from stale ones
}

export function defaultCollectCoverage(input: CoverageCollectInput): CoveredLines | null {
  try {
    return input.target === "code"
      ? collectNativeCoverage(input.repoDir)
      : collectBrowserCoverage(input.e2eDir, input.changedFiles, input.namespace);
  } catch {
    return null; // any read/parse failure → unmeasured, never a false fail
  }
}

function collectNativeCoverage(repoDir: string): CoveredLines | null {
  // lcov first (universal), then Istanbul JSON (Node default).
  const lcovPaths = ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"];
  for (const rel of lcovPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) {
      const cov = parseLcov(readFileSync(p, "utf8"), repoDir);
      if (cov.size) return cov;
    }
  }
  const istanbul = join(repoDir, "coverage", "coverage-final.json");
  if (existsSync(istanbul)) {
    const cov = parseIstanbulJson(JSON.parse(readFileSync(istanbul, "utf8")), repoDir);
    if (cov.size) return cov;
  }
  return null;
}

// The run's V8 dump directory. Single source of truth for the path so the collector
// and the cleaner (clearBrowserCoverage) can never drift apart.
function browserCoverageDir(e2eDir: string, namespace: string): string {
  return join(e2eDir, ".qa", "coverage", namespace);
}

// Remove a run's V8 dumps so a measurement reflects ONLY the execute that just ran.
// Called before each measured execute: stale dumps from a prior same-sha run survive
// `git clean -fd` (the dir is gitignored), and an enforce re-run would otherwise union
// round-1 and round-2 dumps. force:true makes it idempotent when the dir is absent.
export function clearBrowserCoverage(e2eDir: string, namespace: string): void {
  rmSync(browserCoverageDir(e2eDir, namespace), { recursive: true, force: true });
}

// Did the suite emit ANY V8 dumps this run? Lets the orchestrator distinguish a benign
// "no coverage data" (legitimately "unknown") from a STRUCTURAL NO-OP — dumps were
// produced but none mapped to a changed file (a bundled/minified deploy whose asset URLs
// never match repo source paths, or specs not importing ./fixtures). The latter is worth
// a loud warning because the keystone is silently protecting nothing.
export function hasBrowserCoverageDumps(e2eDir: string, namespace: string): boolean {
  try {
    const dir = browserCoverageDir(e2eDir, namespace);
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

function collectBrowserCoverage(e2eDir: string, changedFiles: string[], namespace: string): CoveredLines | null {
  // Per-namespace subdir so a previous commit's dumps can never pollute this run's measurement.
  const dir = browserCoverageDir(e2eDir, namespace);
  if (!existsSync(dir)) return null;
  const merged: CoveredLines = new Map();
  let any = false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let entries: V8Entry[];
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }
    const cov = parseV8Coverage(entries, changedFiles);
    for (const [file, lines] of cov) {
      any = true;
      const set = merged.get(file) ?? new Set<number>();
      for (const l of lines) set.add(l);
      merged.set(file, set);
    }
  }
  return any ? merged : null;
}

// qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts
// THE MISSING ASSEMBLY STEP — closes the gap the ObjectiveSignalPortAdapter's own header documents
// ("PLAN DRIFT... there is NO assembly function under objective-signal/ that turns
// CoverageCollectorPort's raw CoverageReport + the diff into the ChangeCoverage read-model
// DecideCoverageService.decide() actually consumes"). Ported verbatim (parity-pinned) from
// src/qa/change-coverage.ts's parseDiffHunks + computeChangeCoverage — no new coverage-ratio logic
// is introduced here, only the port-shape conversion CoverageReport (CoveredLines[]) <->
// Map<string, Set<number>> the legacy pure functions operate on.
//
// renderUncovered is deliberately NOT ported: the rewritten RunQaUseCase has no enforce-mode
// regeneration hook that consumes a coverage-gap string (its own coverageWillMeasure flag only
// disables the FixLoop's filtered-retry optimization — grep-confirmed, see run-qa.use-case.ts and
// fix-loop.aggregate.ts). Porting an unconsumed renderer here would be dead code; flagged as a
// tracked follow-on gap instead (see the objective-signal-port.adapter.ts header for the analogous
// precedent of documenting a drift rather than smuggling unused policy into a "thin" layer).
import type { CoverageReport } from "../application/ports/index.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";

// file (repo-relative, POSIX) → set of line numbers (1-based, new-file side for the diff).
// Local alias mirroring src/qa/change-coverage.ts's own CoveredLines type.
type CoveredLines = Map<string, Set<number>>;

// ── Diff → changed lines (pure) ──────────────────────────────────────────────
// VERBATIM port of src/qa/change-coverage.ts:75 parseDiffHunks. Returns the ADDED/modified lines
// per file, numbered on the NEW side (which matches the working copy checked out at the SHA, i.e.
// what coverage reports against). Pure deletions contribute no new lines (a removed line cannot be
// "covered"), so such files simply do not appear.
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
// VERBATIM port of src/qa/change-coverage.ts:124 computeChangeCoverage. No coveredBranches param —
// the rewritten port's CoverageReport carries no branch data yet (ValueOraclePort covers the
// mutation-testing signal instead); branches stays null here, matching decide()'s own "null = not
// measured, never a false signal" contract.
export function computeChangeCoverage(changed: CoveredLines, covered: CoveredLines): ChangeCoverage {
  const perFile: ChangeCoverage["perFile"] = [];
  const uncovered: ChangeCoverage["uncovered"] = [];
  let totalChanged = 0;
  let totalCovered = 0;
  let anyFileMeasured = false;

  for (const [file, lineSet] of changed) {
    const cov = covered.get(file);
    if (cov) anyFileMeasured = true;
    let fileCovered = 0;
    const fileUncovered: number[] = [];
    for (const ln of lineSet) {
      if (cov?.has(ln)) fileCovered++;
      else fileUncovered.push(ln);
    }
    totalChanged += lineSet.size;
    totalCovered += fileCovered;
    perFile.push({ file, changed: lineSet.size, covered: fileCovered, ratio: lineSet.size ? fileCovered / lineSet.size : 1 });
    if (fileUncovered.length) uncovered.push({ file, lines: fileUncovered.sort((a, b) => a - b) });
  }

  return {
    measured: anyFileMeasured,
    overall: { changedLines: totalChanged, coveredChanged: totalCovered, ratio: totalChanged ? totalCovered / totalChanged : 1 },
    perFile,
    uncovered,
    branches: null,
  };
}

// ── Report-shape conversion ───────────────────────────────────────────────────
// CoverageCollectorPort.collect() returns CoverageReport { covered: { file, lines }[] } (the port's
// own array-of-objects shape) — convert to the legacy CoveredLines Map<string, Set<number>> shape
// computeChangeCoverage operates on. Pure, no IO.
function toCoveredLines(report: CoverageReport): CoveredLines {
  const out: CoveredLines = new Map();
  for (const entry of report.covered) {
    out.set(entry.file, new Set(entry.lines));
  }
  return out;
}

// ── The assembler (the exported seam) ────────────────────────────────────────
// Pure: parses the run's diff into changed lines, converts the collector's raw CoverageReport into
// the same CoveredLines shape, and intersects — producing the ChangeCoverage read-model
// DecideCoverageService.decide() consumes. Matches ObjectiveSignalPortStaticContext's
// `assembleChangeCoverage` seam shape (composition-root.ts / objective-signal-port.adapter.ts).
export function assembleChangeCoverage(diff: string, report: CoverageReport): ChangeCoverage {
  const changed = parseDiffHunks(diff);
  const covered = toCoveredLines(report);
  return computeChangeCoverage(changed, covered);
}

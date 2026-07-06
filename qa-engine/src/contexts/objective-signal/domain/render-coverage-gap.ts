// qa-engine/src/contexts/objective-signal/domain/render-coverage-gap.ts
// post-cutover-remediation P2c (unit 5): the enforce-mode regen's own coverage-gap renderer. Closes
// assemble-change-coverage.ts's own documented deferral ("renderUncovered is deliberately NOT
// ported... no enforce-mode regeneration hook that consumes a coverage-gap string" — see that
// file's header) — this IS that hook. Symmetric to (but not a verbatim port of) the legacy
// renderUncovered (deleted at cutover 1228ea7; git show 1228ea7^:src/qa/change-coverage.ts:184-191)
// — the legacy took a full ChangeCoverage (with overall.ratio); this renderer takes the widened
// ObjectiveSignalPort.measure() return's own `uncovered?: {file; lines: number[]}[]` shape directly
// (unit 2), which carries no nested ratio, so the rendered text omits the legacy's ratio-percentage
// prefix. Pure; no I/O; never throws. Characterized with HAND-WRITTEN expected outputs (no live
// comparator — the legacy original no longer exists to parity-test against).

type Uncovered = { file: string; lines: number[] }[];

// VERBATIM port of the legacy's own compactRanges (same file, :193-207) — collapses a sorted line
// list into "N" / "N-M" range tokens, comma-joined.
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

export function renderCoverageGap(uncovered: Uncovered, max = 10): string {
  if (uncovered.length === 0) return "all changed lines are covered by the tests";
  const lines = uncovered.slice(0, max).map((u) => `- ${u.file}: lines ${compactRanges(u.lines)}`);
  const more = uncovered.length > max ? `\n…and ${uncovered.length - max} more file(s)` : "";
  return `changed lines NOT exercised by any test:\n${lines.join("\n")}${more}`;
}

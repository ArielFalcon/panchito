// file (repo-relative, POSIX) → set of 1-based line numbers on the NEW side. The unit the analyze
// and coverage phases intersect on. Carried verbatim from src/qa/change-coverage.ts CoveredLines.
export type ChangedLines = Map<string, Set<number>>;

// One unified-diff hunk header: the new-side start line + how many lines it spans.
export interface DiffHunk {
  file: string;
  newStart: number;
  newCount: number;
}

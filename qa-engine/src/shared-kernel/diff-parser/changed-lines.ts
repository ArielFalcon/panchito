// file (repo-relative, POSIX) → set of 1-based line numbers on the NEW side. The unit the analyze
// and coverage phases intersect on. Carried verbatim from src/qa/change-coverage.ts CoveredLines.
export type ChangedLines = Map<string, Set<number>>;

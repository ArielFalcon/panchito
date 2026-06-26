// src/contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts
// CoverageCollectorPort over lcov. The missing DI seam: the file read is injected (no hard-coded
// readFileSync), so this is unit-testable without disk and fail-open by contract (no files → empty
// report, never a throw). The lcov→CoveredLines parse is injected too (defaults to the verified
// src/qa/change-coverage.ts parseLcov via the Plan-6 composition) — this adapter does not rewrite
// the parser; it adapts Map<string,Set<number>> to the port's CoveredLines[] shape.
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

export interface CoverageFile { path: string; text: string; }
type ReadLcovFiles = (specDir: string, namespace: string) => Promise<CoverageFile[]>;
// repoDir is passed from the constructor; the injected default handles it as optional so this type
// also accepts parseLcov from src/qa/change-coverage.ts (which declares repoDir?: string).
type ParseLcov = (text: string, repoDir?: string) => Map<string, Set<number>>;

export class LcovCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readFiles: ReadLcovFiles,
    private readonly repoDir: string,
    private readonly parse: ParseLcov = defaultParseLcov,
  ) {}

  async collect(specDir: string, namespace: string): Promise<CoverageReport> {
    const files = await this.readFiles(specDir, namespace);
    const merged = new Map<string, Set<number>>();
    for (const f of files) {
      for (const [file, lines] of this.parse(f.text, this.repoDir)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

// Verbatim-carried lcov parser (SF/DA/end_of_record, hits>0). Copied VERBATIM from
// change-coverage.ts parseLcov — including the `end_of_record` reset (file = null) AND the
// normalizeRepoPath call on the SF: path. Kept local so the adapter has a self-contained default;
// the parity test pins it to the legacy original.
// CRITICAL: end_of_record MUST reset `file` to null so a second SF block in the same text does
// not inherit the previous file's Set (the real parseLcov does this; omitting it causes DA lines
// from block 2 to be attributed to the last file of block 1).
// CRITICAL: the SF: path MUST pass through normalizeRepoPath(raw, repoDir) — the real parseLcov
// does this to strip the absolute repoDir prefix so coverage paths and diff paths intersect on
// the same repo-relative POSIX keys. Omitting it causes every absolute SF path to miss the diff
// intersection (visible in the parity fixture — see the test below).
function normalizeRepoPath(p: string, repoDir?: string): string {
  let out = p.replace(/\\/g, "/").trim();
  if (repoDir) {
    const root = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (out.startsWith(root + "/")) out = out.slice(root.length + 1);
  }
  return out.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function defaultParseLcov(text: string, repoDir?: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = normalizeRepoPath(line.slice(3).trim(), repoDir);
      if (!out.has(file)) out.set(file, new Set());
    } else if (line.startsWith("DA:") && file) {
      const [lnStr, hitsStr] = line.slice(3).split(",");
      const ln = Number(lnStr); const hits = Number(hitsStr);
      if (Number.isFinite(ln) && hits > 0) out.get(file)!.add(ln);
    } else if (line.startsWith("end_of_record")) {
      file = null;
    }
  }
  return out;
}

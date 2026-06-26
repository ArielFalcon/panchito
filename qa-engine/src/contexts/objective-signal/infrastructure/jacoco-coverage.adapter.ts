// src/contexts/objective-signal/infrastructure/jacoco-coverage.adapter.ts
// CoverageCollectorPort over JaCoCo XML (JVM: Maven/Gradle). The missing DI seam: the file read
// is injected (no hard-coded readFileSync), so this is unit-testable without disk and fail-open
// by contract (no files → empty report, never a throw). The JaCoCo→CoveredLines parse is injected
// (defaults to the verbatim-carried parseJacocoXml below, parity-pinned to the legacy original).
// changedFiles is needed by the parser to resolve package+file names to repo-relative paths via
// longest suffix match — pass it through the constructor (it is per-run, from BlastRadius).
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

export interface JacocoFile { path: string; text: string; }
type ReadJacocoFiles = (specDir: string, namespace: string) => Promise<JacocoFile[]>;
type ParseJacoco = (xml: string, changedFiles: string[]) => Map<string, Set<number>>;

export class JacocoCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readFiles: ReadJacocoFiles,
    private readonly changedFiles: string[],
    private readonly parse: ParseJacoco = defaultParseJacocoXml,
  ) {}

  async collect(specDir: string, namespace: string): Promise<CoverageReport> {
    const files = await this.readFiles(specDir, namespace);
    const merged = new Map<string, Set<number>>();
    for (const f of files) {
      for (const [file, lines] of this.parse(f.text, this.changedFiles)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

// Resolve a JaCoCo package+file path to a repo-relative path via longest suffix match.
// Verbatim from change-coverage.ts resolveUrlToRepoFile (the same algorithm — JaCoCo uses
// POSIX-style package names like "com/example/Foo.java", not URLs, but the suffix logic is identical).
function resolveUrlToRepoFile(url: string, changedFiles: string[]): string | null {
  const path = url.replace(/\\/g, "/").replace(/^\/+/, "");
  let best: string | null = null;
  let bestLen = 0;
  for (const f of changedFiles) {
    const nf = f.replace(/\\/g, "/");
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

// Verbatim-carried JaCoCo XML parser from change-coverage.ts parseJacocoXml. Regex-based (no XML
// lib — the orchestrator ships none); reads package/sourcefile/line nr+ci. A line with ci>0 is
// covered. The parity test pins this copy to the legacy original.
export function defaultParseJacocoXml(xml: string, changedFiles: string[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const pkgRe = /<package\s+name="([^"]*)"\s*>([\s\S]*?)<\/package>/g;
  let pkg: RegExpExecArray | null;
  while ((pkg = pkgRe.exec(xml))) {
    const pkgName = pkg[1]!;
    const sfRe = /<sourcefile\s+name="([^"]*)"\s*>([\s\S]*?)<\/sourcefile>/g;
    let sf: RegExpExecArray | null;
    while ((sf = sfRe.exec(pkg[2]!))) {
      const rel = (pkgName ? pkgName + "/" : "") + sf[1]!;
      const repoFile = resolveUrlToRepoFile(rel, changedFiles);
      if (!repoFile) continue;
      const set = out.get(repoFile) ?? new Set<number>();
      const lineRe = /<line\s+([^>]*?)\/>/g;
      let ln: RegExpExecArray | null;
      while ((ln = lineRe.exec(sf[2]!))) {
        const attrs = ln[1]!;
        const nr = Number(/\bnr="(\d+)"/.exec(attrs)?.[1]);
        const ci = Number(/\bci="(\d+)"/.exec(attrs)?.[1] ?? "0");
        if (Number.isFinite(nr) && ci > 0) set.add(nr);
      }
      if (set.size) out.set(repoFile, set);
    }
  }
  return out;
}

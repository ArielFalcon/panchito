// src/contexts/objective-signal/infrastructure/c8-coverage.adapter.ts
// CoverageCollectorPort over Istanbul/c8 coverage-final.json. The missing DI seam: the file read
// is injected (no hard-coded readFileSync), so this is unit-testable without disk and fail-open
// by contract (no files → empty report, never a throw). The Istanbul→CoveredLines parse is injected
// too (defaults to the verified src/qa/change-coverage.ts parseIstanbulJson via Plan-6 composition)
// — this adapter does not rewrite the parser; it adapts Map<string,Set<number>> to CoveredLines[].
import { isAbsolute, relative } from "node:path";
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

export interface IstanbulFile { path: string; json: unknown; }
type ReadIstanbulFiles = (specDir: string, namespace: string) => Promise<IstanbulFile[]>;
type ParseIstanbul = (json: unknown, repoDir?: string) => Map<string, Set<number>>;

export class C8CoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readFiles: ReadIstanbulFiles,
    private readonly repoDir: string,
    private readonly parse: ParseIstanbul = defaultParseIstanbulJson,
  ) {}

  async collect(specDir: string, namespace: string): Promise<CoverageReport> {
    const files = await this.readFiles(specDir, namespace);
    const merged = new Map<string, Set<number>>();
    for (const f of files) {
      for (const [file, lines] of this.parse(f.json, this.repoDir)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

// Verbatim-carried Istanbul parser from change-coverage.ts parseIstanbulJson.
// Copies the exact logic: statementMap[id] + counts s[id], expanding start→end line ranges.
// The parity test pins this copy to the legacy original.
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

export function defaultParseIstanbulJson(json: unknown, repoDir?: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if (!json || typeof json !== "object") return out;
  for (const [rawPath, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      path?: string;
      statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
      s?: Record<string, number>;
    };
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

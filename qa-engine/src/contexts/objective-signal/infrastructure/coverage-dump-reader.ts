// qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts
// THE MISSING FS BOUNDARY — Sub-Plan 7.2 item 2 (F.2 GAP, engram obs #914/#911).
//
// Each collector adapter (V8BrowserCoverageAdapter / LcovCoverageAdapter / C8CoverageAdapter /
// JacocoCoverageAdapter) already carries a src/-free, parity-pinned DUMP PARSER (defaultParseV8Coverage
// / defaultParseLcov / defaultParseIstanbulJson / defaultParseJacocoXml) — those were ported verbatim
// from src/qa/change-coverage.ts in an earlier slice and are NOT touched here. What was missing is the
// FS READ side: the injected `(specDir, namespace) => Promise<T[]>` closures each adapter's
// constructor declares but never got a real default for. F.2 (Plan 6) hit exactly this gap and
// bypassed it entirely with a re-shape of `defaultCollectCoverage()` — this module is the real fix
// that lets `V8BrowserCoverageAdapter`/`LcovCoverageAdapter`/`C8CoverageAdapter`/`JacocoCoverageAdapter`
// be constructed WITHOUT borrowing anything from root src/.
//
// Conventional paths are carried verbatim from src/qa/change-coverage.ts's collectBrowserCoverage /
// collectNativeCoverage (browserCoverageDir, the 3 lcov paths, coverage-final.json, the 3 JaCoCo
// paths) — porting the LOCATION convention, not re-deriving it. Every reader is fail-open by
// contract: an absent directory/file, or a corrupt one, degrades to an empty array — it NEVER
// throws. This is load-bearing for the keystone invariant (DecideCoverageService.decide() treats an
// empty CoverageReport as "unmeasured" -> "unknown" -> NEVER blocks publish); a reader that threw
// instead of degrading would turn a benign "no coverage data" into a crashed run.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { V8DumpFile } from "./v8-browser-coverage.adapter.ts";
import type { CoverageFile } from "./lcov-coverage.adapter.ts";
import type { IstanbulFile } from "./c8-coverage.adapter.ts";
import type { JacocoFile } from "./jacoco-coverage.adapter.ts";

// ── V8 browser dumps (e2e target) ────────────────────────────────────────────────────────────
// Verbatim location convention from change-coverage.ts browserCoverageDir: the run's V8 dumps live
// under join(e2eDir, ".qa", "coverage", namespace) — one JSON file per Playwright worker/page. Here
// `specDir` IS the e2eDir (the ONLY reader for which the port's specDir argument is load-bearing —
// the native readers below take their base directory from the adapter's constructor instead, matching
// the existing LcovCoverageAdapter/C8CoverageAdapter/JacocoCoverageAdapter `repoDir` constructor param).
export async function readV8Dumps(e2eDir: string, namespace: string): Promise<V8DumpFile[]> {
  const dir = join(e2eDir, ".qa", "coverage", namespace);
  if (!existsSync(dir)) return [];
  const out: V8DumpFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      out.push({ path, entries: Array.isArray(parsed) ? parsed : [] });
    } catch {
      // corrupt dump file — skip it, never throw (fail-open, matches legacy collectBrowserCoverage's
      // own try/catch-per-file behavior in src/qa/change-coverage.ts).
      continue;
    }
  }
  return out;
}

// ── lcov (code target) ───────────────────────────────────────────────────────────────────────
// Verbatim conventional path list from change-coverage.ts collectNativeCoverage's lcovPaths. namespace
// is accepted (matching the ReadLcovFiles injected type) but unused — native coverage reports are
// written by the target repo's OWN test runner to one conventional location, not per-namespace.
export async function readLcovFiles(repoDir: string, _namespace: string): Promise<CoverageFile[]> {
  const lcovPaths = ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"];
  for (const rel of lcovPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) return [{ path: p, text: readFileSync(p, "utf8") }];
  }
  return [];
}

// ── Istanbul coverage-final.json (code target, Node's c8/nyc default) ───────────────────────────
export async function readIstanbulFiles(repoDir: string, _namespace: string): Promise<IstanbulFile[]> {
  const p = join(repoDir, "coverage", "coverage-final.json");
  if (!existsSync(p)) return [];
  try {
    return [{ path: p, json: JSON.parse(readFileSync(p, "utf8")) }];
  } catch {
    // corrupt report — degrade to [], never throw (fail-open).
    return [];
  }
}

// ── JaCoCo XML (code target, JVM/Maven/Gradle) ──────────────────────────────────────────────────
// Verbatim conventional path list from change-coverage.ts collectNativeCoverage's jacocoPaths.
export async function readJacocoFiles(repoDir: string, _namespace: string): Promise<JacocoFile[]> {
  const jacocoPaths = [
    "target/site/jacoco/jacoco.xml", // Maven default
    "build/reports/jacoco/test/jacocoTestReport.xml", // Gradle default
    "target/jacoco.xml",
  ];
  for (const rel of jacocoPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) return [{ path: p, text: readFileSync(p, "utf8") }];
  }
  return [];
}

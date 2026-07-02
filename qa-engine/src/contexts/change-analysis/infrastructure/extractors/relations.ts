// Tree-sitter WASM-based intra-repo relation graph.
// Extracts import edges between changed files so the agent can test flows that cross
// file boundaries (interconnected flows) rather than each file in isolation.
//
// Ported from src/qa/static-signal/relations.ts (Plan 7.3 §2 — sever the qa-engine→src/ import
// edge): same behavior, byte-for-byte, using qa-engine's own LanguageRegistry instead of the
// legacy languages.ts, and the local symbols.ts port for the parser/language cache.
//
// Confirmed import node shapes (tree-sitter-wasms 0.1.13 / web-tree-sitter 0.20.8):
//   TypeScript: import_statement → source field is a `string` node whose first named
//               child is a `string_fragment` giving the raw specifier (no quotes).
//   Java:       import_declaration → first named child is a `scoped_identifier`
//               whose `.text` gives the dotted package path (e.g. "com.x.Y").
//               Heuristic resolution to Maven/Gradle layout paths; raw specifier kept
//               when no matching file is found (fail-open).
//
// TypeScript path alias resolution: reads tsconfig.json once per repoDir
// (compilerOptions.paths + baseUrl) and expands aliased specifiers before the
// existing extension-resolution. Fail-open: no tsconfig / unparseable → existing behaviour.
//
// Reuses the parser/language cache from symbols.ts — no duplicate WASM init.
// Fail-open: parse or grammar errors for a file contribute zero edges.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import type Parser from "web-tree-sitter";
import type { RelationEdge } from "../../domain/static-signal.ts";
import { LanguageRegistry, type LanguageId } from "../../domain/language-id.ts";
import { getCachedParser, getCachedLanguage, extractSymbols } from "./symbols.ts";

// ── tsconfig path-alias cache ────────────────────────────────────────────

interface TsconfigPaths {
  baseUrl: string; // absolute path
  aliases: Array<{ prefix: string; replacement: string }>; // sorted longest-prefix-first
}

// Keyed by repoDir, but the entry also carries the tsconfig's mtime. The orchestrator is a
// long-lived process that reuses each repo's mirror (a stable repoDir), so a plain repoDir-keyed
// cache would serve STALE aliases for the rest of the process life after a commit edits tsconfig.json.
// Invalidating on mtime makes a tsconfig edit visible on the next run — fresh structure, never stale.
const tsconfigCache = new Map<string, { mtimeMs: number; paths: TsconfigPaths | null }>();

/**
 * Read compilerOptions.paths + baseUrl from a repo's tsconfig.json, cached and KEYED BY MTIME.
 * Returns null when tsconfig is absent or unparseable (fail-open).
 */
function loadTsconfigPaths(repoDir: string): TsconfigPaths | null {
  const tsconfigPath = join(repoDir, "tsconfig.json");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(tsconfigPath).mtimeMs;
  } catch {
    return null; // absent / unreadable → fail-open, nothing to cache
  }
  const cached = tsconfigCache.get(repoDir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.paths;
  let paths: TsconfigPaths | null;
  try {
    const raw = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    const opts = raw?.compilerOptions ?? {};
    const baseUrl = opts.baseUrl ? resolve(repoDir, opts.baseUrl as string) : repoDir;
    const pathsRaw: Record<string, string[]> = opts.paths ?? {};
    // Build alias list: prefix (with * stripped) → first replacement (with * stripped).
    // Sort longest-first so more specific aliases win (e.g. "@/components/" before "@/").
    const aliases: TsconfigPaths["aliases"] = Object.entries(pathsRaw)
      .filter(([, v]) => Array.isArray(v) && v.length > 0)
      .map(([key, values]) => ({
        prefix: key.replace(/\*$/, ""),
        replacement: (values[0] as string).replace(/\*$/, ""),
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    paths = { baseUrl, aliases };
  } catch {
    paths = null;
  }
  tsconfigCache.set(repoDir, { mtimeMs, paths });
  return paths;
}

/**
 * Try to expand a TypeScript path alias specifier using the repo's tsconfig.
 * Returns null when no alias matches or tsconfig is not available (fail-open).
 */
function resolveAliasSpecifier(
  specifier: string,
  repoDir: string,
): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return null;
  const tsconfig = loadTsconfigPaths(repoDir);
  if (!tsconfig) return null;
  for (const { prefix, replacement } of tsconfig.aliases) {
    if (specifier.startsWith(prefix)) {
      const rest = specifier.slice(prefix.length);
      const expanded = resolve(tsconfig.baseUrl, replacement + rest);
      // Try with each extension.
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
        const candidate = expanded + ext;
        if (existsSync(candidate)) {
          const rel = relative(repoDir, candidate).replace(/\\/g, "/");
          if (!rel.startsWith("..")) return rel;
        }
        const indexCandidate = join(expanded, `index${ext}`);
        if (existsSync(indexCandidate)) {
          const rel = relative(repoDir, indexCandidate).replace(/\\/g, "/");
          if (!rel.startsWith("..")) return rel;
        }
      }
      // Alias matched but no file found — still return null to keep raw specifier.
      return null;
    }
  }
  return null;
}

// ── Java heuristic resolution ────────────────────────────────────────────

/**
 * Try to resolve a Java dotted import specifier (e.g. "com.example.UserService") to
 * a repo-relative file path using conventional Maven/Gradle layouts:
 *   src/main/java/<path>.java  and  src/test/java/<path>.java
 * Returns null when no file is found (fail-open — keeps the raw specifier as `to`).
 */
function resolveJavaSpecifier(specifier: string, repoDir: string): string | null {
  if (!specifier.includes(".")) return null; // not a dotted import
  const filePath = specifier.replace(/\./g, "/") + ".java";
  const candidates = [
    join("src", "main", "java", filePath),
    join("src", "test", "java", filePath),
  ];
  for (const rel of candidates) {
    if (existsSync(join(repoDir, rel))) {
      return rel.replace(/\\/g, "/");
    }
  }
  return null;
}

// Supported extensions for resolving relative specifiers. Order matters: try .ts before .tsx etc.
const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

// ── Import node visitors ──────────────────────────────────────────────────────

interface ImportInfo {
  specifier: string; // raw import path / module specifier
  names: string[];   // imported symbol names (for `via`)
}

function collectTsImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node || node.type !== "import_statement") continue;

    // source field is the `string` node; its first named child is `string_fragment`.
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) continue;
    const fragNode = sourceNode.namedChild(0);
    const specifier = fragNode?.text ?? sourceNode.text.replace(/^["']|["']$/g, "");
    if (!specifier) continue;

    // Collect named imported symbols from the import_clause.
    const names: string[] = [];
    for (let j = 0; j < node.childCount; j++) {
      const clause = node.child(j);
      if (!clause || clause.type !== "import_clause") continue;
      // named_imports → import_specifier → identifier (the local name)
      for (let k = 0; k < clause.childCount; k++) {
        const namedImports = clause.child(k);
        if (!namedImports || namedImports.type !== "named_imports") continue;
        for (let l = 0; l < namedImports.childCount; l++) {
          const spec = namedImports.child(l);
          if (!spec || spec.type !== "import_specifier") continue;
          const nameNode = spec.childForFieldName("name") ?? spec.namedChild(0);
          if (nameNode) names.push(nameNode.text);
        }
      }
      // Default import: the identifier directly under import_clause
      for (let k = 0; k < clause.childCount; k++) {
        const ch = clause.child(k);
        if (ch && ch.type === "identifier") names.push(ch.text);
      }
    }

    imports.push({ specifier, names });
  }
  return imports;
}

function collectJavaImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node || node.type !== "import_declaration") continue;
    // First named child is the scoped_identifier (e.g. "com.x.Y").
    const scopedId = node.namedChild(0);
    if (!scopedId) continue;
    const specifier = scopedId.text;
    if (!specifier) continue;
    // The last segment (simple name) is the imported symbol.
    const lastDot = specifier.lastIndexOf(".");
    const name = lastDot >= 0 ? specifier.slice(lastDot + 1) : specifier;
    imports.push({ specifier, names: [name] });
  }
  return imports;
}

// ── Specifier → file resolution ───────────────────────────────────────────────

/**
 * Try to resolve a relative TypeScript/JS specifier to a repo-relative file path.
 * Returns null when the resolution produces no match in `repoDir`.
 */
function resolveRelativeSpecifier(
  specifier: string,
  importingFileRepoRelative: string,
  repoDir: string,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

  const importingAbs = resolve(repoDir, importingFileRepoRelative);
  const importingDir = dirname(importingAbs);
  const base = resolve(importingDir, specifier);

  // Candidate paths: exact specifier, then each supported extension appended.
  const candidates: string[] = [base];
  for (const ext of TS_EXTENSIONS) {
    candidates.push(base + ext);
    candidates.push(join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const rel = relative(repoDir, candidate).replace(/\\/g, "/");
      // Only accept paths inside the repo (no leading "..").
      if (!rel.startsWith("..")) return rel;
    }
  }
  return null;
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract directed import edges among the given repo-relative file paths.
 *
 * - Reuses the parser/language cache from symbols.ts (no duplicate WASM load).
 * - Resolves relative specifiers to repo-relative paths when the target file exists.
 * - Keeps unresolved specifiers (non-relative or file not found) as the raw `to` string.
 * - `via` is the comma-joined list of imported symbols, or the raw specifier.
 * - Fail-open: a file that cannot be read or parsed contributes zero edges.
 */
export async function extractRelations(
  files: string[],
  repoDir: string,
): Promise<RelationEdge[]> {
  // Ensure parsers are loaded by running extractSymbols as a no-op trigger
  // (it initialises Parser.init() and caches grammars for all supported languages).
  // We pass the same files so the grammars we need are warm.
  await extractSymbols(files, repoDir);

  const byLang = LanguageRegistry.groupByLanguage(files);
  const result: RelationEdge[] = [];

  for (const [lang, langFiles] of byLang) {
    const parser = getCachedParser(lang as LanguageId);
    if (!parser) continue;

    const language = getCachedLanguage(lang as LanguageId);
    if (!language) continue;

    for (const file of langFiles) {
      try {
        const src = readFileSync(join(repoDir, file), "utf8");
        const tree = parser.parse(src);

        const imports: ImportInfo[] =
          lang === "java"
            ? collectJavaImports(tree.rootNode)
            : collectTsImports(tree.rootNode); // typescript + javascript

        for (const { specifier, names } of imports) {
          // Resolution priority:
          //   1. Relative specifier (./... or ../...) — existing behaviour.
          //   2. TypeScript path alias (@/... or custom prefix).
          //   3. Java dotted specifier heuristic.
          //   4. Raw specifier kept as-is (fail-open — existing behaviour).
          const resolved =
            resolveRelativeSpecifier(specifier, file, repoDir) ??
            resolveAliasSpecifier(specifier, repoDir) ??
            (lang === "java" ? resolveJavaSpecifier(specifier, repoDir) : null);
          const to = resolved ?? specifier;
          const via = names.length > 0 ? names.join(", ") : specifier;

          result.push({ from: file, to, via });
        }
      } catch {
        // Read or parse failure — fail-open, contribute no edges for this file.
      }
    }
  }

  return result;
}

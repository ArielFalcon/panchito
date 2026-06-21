// Tree-sitter WASM-based intra-repo relation graph.
// Extracts import edges between changed files so the agent can test flows that cross
// file boundaries (interconnected flows) rather than each file in isolation.
//
// Confirmed import node shapes (tree-sitter-wasms 0.1.13 / web-tree-sitter 0.20.8):
//   TypeScript: import_statement → source field is a `string` node whose first named
//               child is a `string_fragment` giving the raw specifier (no quotes).
//   Java:       import_declaration → first named child is a `scoped_identifier`
//               whose `.text` gives the dotted package path (e.g. "com.x.Y").
//               No reliable file-path resolution without the full project layout;
//               the scoped specifier is kept as-is in `to`.
//
// Reuses the parser/language cache from symbols.ts — no duplicate WASM init.
// Fail-open: parse or grammar errors for a file contribute zero edges.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import type Parser from "web-tree-sitter";
import type { RelationEdge } from "./types";
import { groupByLanguage, languageForFile, type LanguageId } from "./languages";
import { getCachedParser, getCachedLanguage, extractSymbols } from "./symbols";

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

  const byLang = groupByLanguage(files);
  const result: RelationEdge[] = [];

  for (const [lang, langFiles] of byLang) {
    const parser = getCachedParser(lang);
    if (!parser) continue;

    const language = getCachedLanguage(lang);
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
          const resolved = resolveRelativeSpecifier(specifier, file, repoDir);
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

// Tree-sitter WASM-based symbol extractor. Parses source files deterministically
// so the agent receives structured symbol+signature data without Serena round-trips.
// Parser cache is exported for reuse by the relations extractor (Task 2.4).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type { ChangedSymbol } from "./types";
import { groupByLanguage, type LanguageId } from "./languages";

// Resolve the tree-sitter-wasms grammar directory relative to this package's node_modules.
const _require = createRequire(import.meta.url);
const WASMS_DIR = resolve(_require.resolve("tree-sitter-wasms/package.json"), "..", "out");

const GRAMMAR_FILE: Record<LanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  java: "tree-sitter-java.wasm",
};

// tsx uses the typescript grammar (TSX is a superset of TypeScript in the grammar).
// The languages.ts maps .tsx → "typescript", so one grammar covers both.

// Map from a node's type string to the canonical kind used in ChangedSymbol.
const NODE_TYPE_TO_KIND: Record<string, string> = {
  function_declaration: "function",
  method_definition: "method",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
};

// --- Parser + Language cache ---

let initPromise: Promise<void> | null = null;
const languageCache = new Map<LanguageId, Parser.Language>();
const parserCache = new Map<LanguageId, Parser>();
// Per-language in-flight guard: concurrent callers for the same language share one load.
const langInit = new Map<LanguageId, Promise<Parser | null>>();

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

async function getParserForLanguage(lang: LanguageId): Promise<Parser | null> {
  if (parserCache.has(lang)) return parserCache.get(lang)!;
  // If a load is already in flight for this language, await the same promise.
  const inflight = langInit.get(lang);
  if (inflight) return inflight;

  const grammarFile = GRAMMAR_FILE[lang];
  if (!grammarFile) return null;
  const wasmPath = join(WASMS_DIR, grammarFile);

  const loadPromise = (async (): Promise<Parser | null> => {
    try {
      const language = await Parser.Language.load(wasmPath);
      languageCache.set(lang, language);
      const parser = new Parser();
      parser.setLanguage(language);
      parserCache.set(lang, parser);
      return parser;
    } catch {
      // Missing or incompatible grammar — skip this language silently.
      return null;
    } finally {
      langInit.delete(lang);
    }
  })();

  langInit.set(lang, loadPromise);
  return loadPromise;
}

/**
 * Expose the parser cache for Task 2.4 (relations extractor) so it can reuse
 * already-loaded grammars without paying the WASM load cost again.
 */
export function getCachedParser(lang: LanguageId): Parser | undefined {
  return parserCache.get(lang);
}

export function getCachedLanguage(lang: LanguageId): Parser.Language | undefined {
  return languageCache.get(lang);
}

// --- Query file loader ---

const queryDir = resolve(import.meta.dirname, "queries");
const queryCache = new Map<LanguageId, string>();

function loadQuerySource(lang: LanguageId): string {
  if (queryCache.has(lang)) return queryCache.get(lang)!;
  // javascript uses its own query; everything else uses the language id directly
  const fileName = `${lang}.scm`;
  const src = readFileSync(join(queryDir, fileName), "utf8");
  queryCache.set(lang, src);
  return src;
}

// --- First line to `{` helper ---

function firstLineSignature(nodeText: string): string {
  const brace = nodeText.indexOf("{");
  const candidate = brace >= 0 ? nodeText.slice(0, brace) : nodeText.split("\n")[0] ?? "";
  return candidate.trim();
}

// --- Main extractor ---

/**
 * Extract named symbols (functions, methods, classes, interfaces) from the given
 * list of file paths (relative names) under `repoDir`.
 *
 * - Groups files by language and skips unsupported ones.
 * - Lazy-inits web-tree-sitter and caches parsers per language across calls.
 * - Fail-open: a missing grammar or parse error for a file contributes [] for that file.
 * - parse() is synchronous WASM; no per-file timeout is claimed. try/catch guards crashes.
 */
export async function extractSymbols(
  files: string[],
  repoDir: string,
): Promise<ChangedSymbol[]> {
  await ensureInit();

  const byLang = groupByLanguage(files);
  const result: ChangedSymbol[] = [];

  for (const [lang, langFiles] of byLang) {
    const parser = await getParserForLanguage(lang);
    if (!parser) continue;

    const language = languageCache.get(lang);
    if (!language) continue;

    let querySource: string;
    try {
      querySource = loadQuerySource(lang);
    } catch {
      // Missing query file — skip language.
      continue;
    }

    let query: Parser.Query;
    try {
      query = language.query(querySource);
    } catch {
      // Invalid query — skip language.
      continue;
    }

    for (const file of langFiles) {
      try {
        const src = readFileSync(join(repoDir, file), "utf8");
        const tree = parser.parse(src);
        const captures = query.captures(tree.rootNode);

        // Process captures pairwise: @decl comes first in each pair, @name second.
        // Group them by matching the decl captures with their name captures.
        const declCaptures = captures.filter((c) => c.name === "decl");
        const nameCaptures = captures.filter((c) => c.name === "name");

        // Build a map from decl node id to name node for quick lookup.
        // Pair each @decl with the @name that has the same parent (the decl node itself).
        for (const decl of declCaptures) {
          // Find the name capture whose node's parent is this decl node (or is a direct child).
          const nameCapture = nameCaptures.find((nc) => {
            const parent = nc.node.parent;
            return parent !== null && parent.id === decl.node.id;
          });
          if (!nameCapture) continue;

          const kind = NODE_TYPE_TO_KIND[decl.node.type];
          if (!kind) continue;

          result.push({
            file,
            name: nameCapture.node.text,
            kind,
            signature: firstLineSignature(decl.node.text),
            line: decl.node.startPosition.row + 1,
          });
        }
      } catch {
        // Read or parse failure for this file — contribute nothing, stay fail-open.
      }
    }
  }

  return result;
}

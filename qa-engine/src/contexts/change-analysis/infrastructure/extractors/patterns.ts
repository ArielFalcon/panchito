// AST-grep pattern extractor with regex fallback.
//
// Ported from src/qa/static-signal/patterns.ts (Plan 7.3 §2 — sever the qa-engine→src/ import
// edge): same behavior, byte-for-byte, using LanguageRegistry.hasAstGrepRules instead of the
// legacy languages.ts + its OWN separate AST_GREP_LANGUAGES set (LanguageRegistry's own header
// comment names killing exactly this drift — one record, not two parallel sets), the local
// runbinary.ts instead of exec.ts, and the local structural-pattern.ts port instead of
// ../learning/structural-pattern.
//
// Extension point: add entries to AST_GREP_RULES to enable structured pattern detection for a
// new pattern name or language. Only languages where LanguageRegistry.hasAstGrepRules(lang) is
// true receive ast-grep rules; all others fall back to the local regex engine.
//
// Decision (single patterns field): ast-grep is PRIMARY for supported languages; the regex engine
// is the FALLBACK for unsupported languages. Both sources are merged into one ChangePattern[]
// deduped by (file, pattern) — no double signal.

import { relative } from "node:path";
import type { ChangePattern } from "../../domain/static-signal.ts";
import { LanguageRegistry, type LanguageId } from "../../domain/language-id.ts";
import { runBinary } from "./runbinary.ts";
import { detectStructuralPatterns } from "./structural-pattern.ts";

// Rule set: pattern-name → per-language ast-grep pattern string.
// Keep this minimal and sound — each pattern must be an actual AST match, not a heuristic.
// Extension point: add new { lang, pattern } entries per pattern name as coverage expands.
interface AstGrepRule {
  lang: string;
  /** ast-grep pattern string passed to --pattern */
  pattern: string;
}

const AST_GREP_RULES: Record<string, AstGrepRule[]> = {
  "api-call": [
    { lang: "javascript", pattern: "fetch($$$)" },
    { lang: "typescript", pattern: "fetch($$$)" },
    { lang: "java", pattern: "$X.get($$$)" },
  ],
  "form-submit": [
    { lang: "javascript", pattern: "$X.addEventListener('submit', $$$)" },
    { lang: "typescript", pattern: "$X.addEventListener('submit', $$$)" },
  ],
};

// Returns the strategy for a given language (string, not LanguageId, to avoid type errors on
// unsupported langs). "ast-grep" means LanguageRegistry has structured rules for it; "regex"
// means fall back. Delegates to the SINGLE registry record — no second parallel set to diverge.
export function patternsForLanguage(lang: string): "ast-grep" | "regex" {
  return LanguageRegistry.hasAstGrepRules(lang as LanguageId) ? "ast-grep" : "regex";
}

// sg 0.43 JSON match shape (--json flag produces a JSON array).
interface SgMatch {
  text: string;
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

// Parse the JSON array emitted by `sg run --json`.
// Returns ChangePattern[] with source "ast-grep". Paths are made repo-relative.
export function parseAstGrepJson(json: string, pattern: string, repoDir: string): ChangePattern[] {
  let matches: SgMatch[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    matches = parsed as SgMatch[];
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const out: ChangePattern[] = [];

  for (const m of matches) {
    if (!m || typeof m.file !== "string") continue;
    const file = relative(repoDir, m.file);
    const key = `${file}\0${pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, pattern, source: "ast-grep" });
  }

  return out;
}

// Run all ast-grep rules for the given lang+files via runBinary, parse results.
async function runAstGrepForLang(
  lang: string,
  files: string[],
  repoDir: string,
): Promise<ChangePattern[]> {
  const rules = Object.entries(AST_GREP_RULES);
  const results: ChangePattern[] = [];

  for (const [patternName, langRules] of rules) {
    const rule = langRules.find((r) => r.lang === lang);
    if (!rule) continue;

    const result = await runBinary(
      "sg",
      ["run", "--pattern", rule.pattern, "--lang", lang, "--json", ...files],
      repoDir,
    );

    // code===null means sg is missing or timed out — degrade to [] for this rule.
    if (result.code === null || !result.stdout.trim()) continue;

    const parsed = parseAstGrepJson(result.stdout, patternName, repoDir);
    results.push(...parsed);
  }

  return results;
}

// Map a StructuralPattern kind to a ChangePattern.pattern name.
function kindToPatternName(kind: string): string {
  // Keep the kind as the pattern name — it's already a stable identifier.
  return kind;
}

// Run ast-grep (primary, supported langs) + regex fallback (unsupported langs) over the given
// files, using the diff to drive the regex engine. Deduplicates by (file, pattern).
export async function extractPatterns(
  files: string[],
  repoDir: string,
  diff: string,
): Promise<ChangePattern[]> {
  const byLang = LanguageRegistry.groupByLanguage(files);
  const seen = new Set<string>();
  const out: ChangePattern[] = [];

  function addUnique(cp: ChangePattern): void {
    const key = `${cp.file}\0${cp.pattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cp);
  }

  // PRIMARY: ast-grep for supported languages.
  for (const [lang, langFiles] of byLang) {
    if (patternsForLanguage(lang) === "ast-grep") {
      const patterns = await runAstGrepForLang(lang, langFiles, repoDir);
      for (const cp of patterns) addUnique(cp);
    }
  }

  // FALLBACK: regex engine via detectStructuralPatterns for languages in LanguageRegistry that
  // have no ast-grep rule set (i.e. patternsForLanguage(lang) === "regex"). Today js/ts/java all
  // have ast-grep rules, so this path is inert; it activates when a future language is added to
  // LanguageRegistry without a corresponding AST_GREP_RULES entry.
  // Collect all files that are NOT covered by ast-grep.
  const unsupportedFiles = files.filter((f) => {
    const lang = LanguageRegistry.languageForFile(f);
    return lang === null || patternsForLanguage(lang) !== "ast-grep";
  });

  if (unsupportedFiles.length > 0) {
    const structuralPatterns = detectStructuralPatterns(diff, unsupportedFiles);
    for (const sp of structuralPatterns) {
      // Map each StructuralPattern to a ChangePattern per file that triggered it.
      // Since detectStructuralPatterns operates on the diff (not per-file), we emit one
      // ChangePattern per (unsupported file, pattern kind) combination.
      const patternName = kindToPatternName(sp.kind);
      for (const f of unsupportedFiles) {
        addUnique({ file: f, pattern: patternName, source: "regex" });
      }
    }
  }

  return out;
}

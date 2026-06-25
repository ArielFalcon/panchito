// The SINGLE source of truth for language support across every extractor in this context. Adding a
// language is ONE record entry here — `supported` and `hasAstGrepRules` BOTH derive from it, so
// there is no second set that could silently diverge. This kills the legacy drift where patterns.ts
// kept its own AST_GREP_LANGUAGES set parallel to languages.ts SUPPORTED_LANGUAGES.
// Project-agnostic: keyed by language, never by app.
export type LanguageId = "javascript" | "typescript" | "java";

// Per-language metadata record: the SINGLE declaration a maintainer touches when adding a language.
// `astGrep: true` → the language has structured ast-grep rules and should use AstGrepPatternAdapter.
// `astGrep: false` → falls back to the regex pattern engine.
// Both `supported` (the registry Set) and `hasAstGrepRules` derive from this record — no second set.
const LANGS: Record<LanguageId, { astGrep: boolean }> = {
  javascript: { astGrep: true },
  typescript: { astGrep: true },
  java:       { astGrep: true },
};

const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  java: "java",
};

export const LanguageRegistry = {
  // Derived from LANGS — adding a new language to LANGS automatically includes it here.
  supported: new Set<LanguageId>(Object.keys(LANGS) as LanguageId[]) as ReadonlySet<LanguageId>,

  languageForFile(file: string): LanguageId | null {
    const dot = file.lastIndexOf(".");
    if (dot < 0) return null;
    return EXT_TO_LANGUAGE[file.slice(dot + 1).toLowerCase()] ?? null;
  },

  groupByLanguage(files: string[]): Map<LanguageId, string[]> {
    const out = new Map<LanguageId, string[]>();
    for (const f of files) {
      const lang = this.languageForFile(f);
      if (!lang) continue;
      const list = out.get(lang) ?? [];
      list.push(f);
      out.set(lang, list);
    }
    return out;
  },

  // Derived from LANGS[lang].astGrep — same record as `supported`. No second set.
  hasAstGrepRules(lang: LanguageId): boolean {
    return LANGS[lang]?.astGrep ?? false;
  },
} as const;

// The SINGLE source of truth for language support across every extractor. Adding a language
// is one entry here plus its grammar/queries/rules in the relevant extractor — nothing else.
// Project-AGNOSTIC: keyed by language, never by app.
export type LanguageId = "javascript" | "typescript" | "java";
export const SUPPORTED_LANGUAGES: ReadonlySet<LanguageId> = new Set(["javascript", "typescript", "java"]);
const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  java: "java",
};
export function languageForFile(file: string): LanguageId | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}
export function groupByLanguage(files: string[]): Map<LanguageId, string[]> {
  const out = new Map<LanguageId, string[]>();
  for (const f of files) {
    const lang = languageForFile(f);
    if (!lang) continue;
    const list = out.get(lang) ?? [];
    list.push(f);
    out.set(lang, list);
  }
  return out;
}

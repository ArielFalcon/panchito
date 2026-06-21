import { EMPTY_STATIC_SIGNAL, type StaticSignal } from "./types";
import { groupByLanguage } from "./languages";
export interface StaticSignalDeps {
  symbols?(files: string[], repoDir: string): Promise<StaticSignal["symbols"]>;
  relations?(files: string[], repoDir: string): Promise<StaticSignal["relations"]>;
  complexity?(files: string[], repoDir: string): Promise<StaticSignal["complexity"]>;
  semanticDiff?(diff: string, repoDir: string, sha: string, baseSha?: string): Promise<StaticSignal["fileChangeKinds"]>;
  patterns?(files: string[], repoDir: string, diff: string): Promise<StaticSignal["patterns"]>;
}
export interface StaticSignalInput { sha: string; baseSha?: string; repoDir: string; changedFiles: string[]; diff: string; }
export async function aggregateStaticSignal(input: StaticSignalInput, deps: StaticSignalDeps): Promise<StaticSignal> {
  const sig = EMPTY_STATIC_SIGNAL(input.sha);
  const byLang = groupByLanguage(input.changedFiles);
  sig.languages = [...byLang.keys()];
  const supportedFiles = [...byLang.values()].flat();
  if (supportedFiles.length === 0) { sig.skipped.push("no changed file is in a supported language (javascript/typescript/java)"); return sig; }
  const guard = async <T>(name: string, run: (() => Promise<T>) | undefined, assign: (v: T) => void): Promise<void> => {
    if (!run) { sig.skipped.push(`${name}: extractor not configured`); return; }
    try { assign(await run()); } catch (err) { sig.skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };
  await Promise.all([
    guard("symbols", deps.symbols && (() => deps.symbols!(supportedFiles, input.repoDir)), (v) => (sig.symbols = v)),
    guard("relations", deps.relations && (() => deps.relations!(supportedFiles, input.repoDir)), (v) => (sig.relations = v)),
    guard("complexity", deps.complexity && (() => deps.complexity!(supportedFiles, input.repoDir)), (v) => (sig.complexity = v)),
    guard("semanticDiff", deps.semanticDiff && (() => deps.semanticDiff!(input.diff, input.repoDir, input.sha, input.baseSha)), (v) => (sig.fileChangeKinds = v)),
    guard("patterns", deps.patterns && (() => deps.patterns!(supportedFiles, input.repoDir, input.diff)), (v) => (sig.patterns = v)),
  ]);
  return sig;
}

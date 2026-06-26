import { isOk } from "@kernel/result.ts";
import type { Result } from "@kernel/result.ts";
import { LanguageRegistry } from "../domain/language-id.ts";
import { emptyStaticSignal, type StaticSignal } from "../domain/static-signal.ts";
import type { ExtractionContext, ExtractorSet, ExtractorSkipped } from "./ports/index.ts";

// Fan out the 5 extractors fail-open and assemble the Sha-keyed StaticSignal. Mirrors the legacy
// aggregateStaticSignal, but every degrade is a TYPED ExtractorSkipped, not an opaque string, and
// a THROWN extractor is caught here (the use-case is the fail-open boundary — nothing reaches the
// orchestrator). Signal-only by contract: this can never block publish.
//
// PARITY NOTE: the legacy `aggregateStaticSignal` passes only `supportedFiles` (files under
// supported languages) to symbols/relations/complexity/patterns, and the raw diff only to
// semanticDiff. This use-case preserves that invariant: `filteredCtx` carries only the
// language-filtered files for the 4 AST-based extractors; the full `ctx` (with diff) goes
// only to semanticDiff. Unsupported files (.rb/.py/.rs etc.) never reach AST extractors.
export async function analyzeChange(ctx: ExtractionContext, extractors: ExtractorSet): Promise<StaticSignal> {
  const sig = emptyStaticSignal(ctx.sha);
  const byLang = LanguageRegistry.groupByLanguage(ctx.changedFiles);
  sig.languages = [...byLang.keys()];
  const supportedFiles = [...byLang.values()].flat();
  if (supportedFiles.length === 0) {
    sig.skipped.push({ extractor: "languages", reason: "no changed file is in a supported language (javascript/typescript/java)" });
    return sig;
  }

  // filteredCtx: same as ctx but changedFiles restricted to the supported-language subset.
  // Passed to symbol/relation/complexity/pattern extractors (AST-based, language-gated).
  // semanticDiff receives the full ctx (needs the raw diff and all file paths).
  const filteredCtx: ExtractionContext = { ...ctx, changedFiles: supportedFiles };

  const run = async <T>(
    name: string,
    port: { extract(c: ExtractionContext): Promise<Result<T, ExtractorSkipped>> } | undefined,
    extractCtx: ExtractionContext,
    assign: (v: T) => void,
  ): Promise<void> => {
    if (!port) { sig.skipped.push({ extractor: name, reason: "extractor not configured" }); return; }
    try {
      const r = await port.extract(extractCtx);
      if (isOk(r)) assign(r.value);
      else sig.skipped.push(r.error);
    } catch (e) {
      sig.skipped.push({ extractor: name, reason: e instanceof Error ? e.message : String(e) });
    }
  };

  await Promise.all([
    run("symbols",      extractors.symbols,      filteredCtx, (v) => (sig.symbols = v)),
    run("relations",    extractors.relations,    filteredCtx, (v) => (sig.relations = v)),
    run("complexity",   extractors.complexity,   filteredCtx, (v) => (sig.complexity = v)),
    run("semanticDiff", extractors.semanticDiff, ctx,         (v) => (sig.fileChangeKinds = v)),
    run("patterns",     extractors.patterns,     filteredCtx, (v) => (sig.patterns = v)),
  ]);
  return sig;
}

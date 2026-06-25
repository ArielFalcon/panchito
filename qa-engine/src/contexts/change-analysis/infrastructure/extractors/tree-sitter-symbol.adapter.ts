import { ok, err, type Result } from "@kernel/result.ts";
import type { SymbolExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ChangedSymbol } from "../../domain/static-signal.ts";

// WRAP-THEN-REPLACE: delegates to the proven tree-sitter extractor; maps degrade → typed skip.
// The underlying fn is injected at construction time (via default-extractors.ts in production;
// stubbed in tests). The WASM grammar is the deliberately-uncovered boundary — not imported here
// so tsc does not pull the src/ tree into the qa-engine composite project.
export type SymbolFn = (files: string[], repoDir: string) => Promise<ChangedSymbol[]>;

export class TreeSitterSymbolAdapter implements SymbolExtractorPort {
  constructor(private readonly run: SymbolFn) {}
  async extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "symbols", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

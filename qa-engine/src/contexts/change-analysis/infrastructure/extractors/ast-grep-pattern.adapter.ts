import { ok, err, type Result } from "@kernel/result.ts";
import type { PatternExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ChangePattern } from "../../domain/static-signal.ts";

// WRAP-THEN-REPLACE: delegates to the proven ast-grep pattern extractor; maps degrade → typed skip.
// extractPatterns is 3-arg: (files, repoDir, diff). Per the language-filter invariant, this adapter
// receives a filteredCtx where changedFiles already contains only supported-language files — the
// use-case has stripped unsupported files before calling this adapter. The underlying fn is injected
// at construction time (via default-extractors.ts in production; stubbed in tests). The sg binary
// is the deliberately-uncovered boundary — not imported here so tsc does not pull src/ into qa-engine.
export type PatternFn = (files: string[], repoDir: string, diff: string) => Promise<ChangePattern[]>;

export class AstGrepPatternAdapter implements PatternExtractorPort {
  constructor(private readonly run: PatternFn) {}
  async extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir, ctx.diff));
    } catch (e) {
      return err({ extractor: "patterns", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

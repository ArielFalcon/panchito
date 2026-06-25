import { ok, err, type Result } from "@kernel/result.ts";
import type { ComplexityExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ComplexityHotspot } from "../../domain/static-signal.ts";

// WRAP-THEN-REPLACE: delegates to the proven lizard complexity extractor; maps degrade → typed skip.
// extractComplexity is 2-arg: (files, repoDir). The underlying fn is injected at construction time
// (via default-extractors.ts in production; stubbed in tests). The lizard binary is the
// deliberately-uncovered boundary — not imported here so tsc does not pull src/ into qa-engine.
export type ComplexityFn = (files: string[], repoDir: string) => Promise<ComplexityHotspot[]>;

export class LizardComplexityAdapter implements ComplexityExtractorPort {
  constructor(private readonly run: ComplexityFn) {}
  async extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "complexity", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

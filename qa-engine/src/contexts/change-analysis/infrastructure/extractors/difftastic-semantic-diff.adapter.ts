import { ok, err, type Result } from "@kernel/result.ts";
import type { SemanticDiffExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { FileChangeKind } from "../../domain/static-signal.ts";

// WRAP-THEN-REPLACE: delegates to the proven difftastic semantic-diff extractor; maps degrade → typed skip.
// extractSemanticDiff is 4-arg: (diff, repoDir, sha, baseSha?). Maps ctx.sha/.baseSha → string values.
// Receives the FULL ctx (not filtered) — semanticDiff needs the raw diff and works on all file paths.
// The underlying fn is injected at construction time (via default-extractors.ts in production; stubbed
// in tests). The difft binary is the deliberately-uncovered boundary — not imported here so tsc does
// not pull src/ into qa-engine.
export type SemanticDiffFn = (diff: string, repoDir: string, sha: string, baseSha?: string) => Promise<FileChangeKind[]>;

export class DifftasticSemanticDiffAdapter implements SemanticDiffExtractorPort {
  constructor(private readonly run: SemanticDiffFn) {}
  async extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.diff, ctx.repoDir, ctx.sha.value, ctx.baseSha?.value));
    } catch (e) {
      return err({ extractor: "semanticDiff", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

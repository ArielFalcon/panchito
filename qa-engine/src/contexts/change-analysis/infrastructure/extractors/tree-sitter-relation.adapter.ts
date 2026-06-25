import { ok, err, type Result } from "@kernel/result.ts";
import type { RelationExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { RelationEdge } from "../../domain/static-signal.ts";

// WRAP-THEN-REPLACE: delegates to the proven tree-sitter relation extractor; maps degrade → typed skip.
// extractRelations is 2-arg: (files, repoDir) — no diff needed. The underlying fn is injected at
// construction time (via default-extractors.ts in production; stubbed in tests). The WASM grammar
// is the deliberately-uncovered boundary — not imported here so tsc does not pull src/ into qa-engine.
export type RelationFn = (files: string[], repoDir: string) => Promise<RelationEdge[]>;

export class TreeSitterRelationAdapter implements RelationExtractorPort {
  constructor(private readonly run: RelationFn) {}
  async extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "relations", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

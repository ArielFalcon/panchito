// qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts
// WRAP of src/integrations/verdict-parse.ts parseVerdict + verdict-validate.ts parseReviewerVerdict.
// FAIL-CLOSED on an unparseable verdict is the legacy contract — inherited, not changed. The reviewer
// path forwards blockingCount + parsed so the blocking-vs-advisory gate and the parse-miss round-saver
// survive. Both parsers injected — no LLM text fixtures needed beyond the test's own.
import type { VerdictParserPort, GeneratorDeliverable, ReviewJudgment } from "../application/ports/index.ts";

interface LegacyVerdict {
  approved?: boolean;
  parsed: boolean;
  specs?: string[];
  note?: string;
}
// Mirrors src/integrations/verdict-validate.ts ReviewerVerdict. valid + issues are REQUIRED in the legacy
// shape (the bounded-repair signal) — declare them here so parseReview can forward them; dropping them
// would make the use-case's contract-repair re-prompt (Task B.3) structurally impossible.
interface LegacyReviewer {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;
  issues: string[];
}

export interface VerdictParsers {
  parseVerdict(text: string): LegacyVerdict;
  parseReviewerVerdict(text: string): LegacyReviewer;
}

export class VerdictParserAdapter implements VerdictParserPort {
  constructor(private readonly p: VerdictParsers) {}

  parseGenerator(text: string): GeneratorDeliverable {
    const v = this.p.parseVerdict(text);
    return { specs: v.specs ?? [], ...(v.note ? { note: v.note } : {}) };
  }

  parseReview(text: string): ReviewJudgment {
    const r = this.p.parseReviewerVerdict(text);
    return {
      approved: r.approved,
      corrections: r.corrections,
      ...(r.rationale ? { rationale: r.rationale } : {}),
      ...(r.blockingCount !== undefined ? { blockingCount: r.blockingCount } : {}),
      ...(r.parsed !== undefined ? { parsed: r.parsed } : {}),
      // valid + issues forwarded verbatim — the use-case (B.3) reads them to fire the bounded reviewer repair.
      ...(r.valid !== undefined ? { valid: r.valid } : {}),
      ...(r.issues !== undefined ? { issues: r.issues } : {}),
    };
  }
}

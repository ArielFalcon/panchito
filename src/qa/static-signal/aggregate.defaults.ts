import type { StaticSignalDeps } from "./aggregate";
import { extractSymbols } from "./symbols";
import { extractRelations } from "./relations";
import { extractComplexity } from "./complexity";
import { extractSemanticDiff } from "./semantic-diff";
import { extractPatterns } from "./patterns";
// The production extractor set. Each is independently fail-open via the aggregator's guard.
export const defaultStaticSignalDeps: StaticSignalDeps = {
  symbols: extractSymbols,
  relations: extractRelations,
  complexity: extractComplexity,
  semanticDiff: extractSemanticDiff,
  patterns: extractPatterns,
};

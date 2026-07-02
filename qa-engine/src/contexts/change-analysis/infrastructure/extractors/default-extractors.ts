// Composition root: wires the qa-engine-native static-signal extractors (Plan 7.3 §2 — ported
// src/-free from the legacy src/qa/static-signal/*) into the adapter set. This file used to import
// the legacy src/ functions directly and was excluded from the qa-engine tsconfig for that reason;
// now that every extractor has a qa-engine home, the src/ edge is severed and this file participates
// in the normal qa-engine tsc project (see qa-engine/tsconfig.json — the exclude entry is removed).
import type { ExtractorSet } from "../../application/ports/index.ts";
import { TreeSitterSymbolAdapter } from "./tree-sitter-symbol.adapter.ts";
import { TreeSitterRelationAdapter } from "./tree-sitter-relation.adapter.ts";
import { LizardComplexityAdapter } from "./lizard-complexity.adapter.ts";
import { DifftasticSemanticDiffAdapter } from "./difftastic-semantic-diff.adapter.ts";
import { AstGrepPatternAdapter } from "./ast-grep-pattern.adapter.ts";
import { extractSymbols } from "./symbols.ts";
import { extractRelations } from "./relations.ts";
import { extractComplexity } from "./complexity.ts";
import { extractSemanticDiff } from "./semantic-diff.ts";
import { extractPatterns } from "./patterns.ts";

// The production extractor set, mirroring src/qa/static-signal/aggregate.defaults.ts. Each adapter
// receives the real extractor function; the composition root injects this whole set.
export const defaultExtractors: ExtractorSet = {
  symbols: new TreeSitterSymbolAdapter(extractSymbols),
  relations: new TreeSitterRelationAdapter(extractRelations),
  complexity: new LizardComplexityAdapter(extractComplexity),
  semanticDiff: new DifftasticSemanticDiffAdapter(extractSemanticDiff),
  patterns: new AstGrepPatternAdapter(extractPatterns),
};

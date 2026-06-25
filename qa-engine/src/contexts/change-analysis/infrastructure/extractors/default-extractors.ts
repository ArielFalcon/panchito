// Composition root: imports the proven src/qa/static-signal/* extractors and wires them into the
// adapter set. This file is excluded from the qa-engine tsconfig (like parity-test files that cross
// the tree boundary) — it is loaded at runtime via tsx, not checked by the qa-engine tsc project.
// tsc for the repo root (tsconfig.json, which includes src/) still validates the extractor imports.
import type { ExtractorSet } from "../../application/ports/index.ts";
import { TreeSitterSymbolAdapter } from "./tree-sitter-symbol.adapter.ts";
import { TreeSitterRelationAdapter } from "./tree-sitter-relation.adapter.ts";
import { LizardComplexityAdapter } from "./lizard-complexity.adapter.ts";
import { DifftasticSemanticDiffAdapter } from "./difftastic-semantic-diff.adapter.ts";
import { AstGrepPatternAdapter } from "./ast-grep-pattern.adapter.ts";
import { extractSymbols } from "../../../../../../src/qa/static-signal/symbols.ts";
import { extractRelations } from "../../../../../../src/qa/static-signal/relations.ts";
import { extractComplexity } from "../../../../../../src/qa/static-signal/complexity.ts";
import { extractSemanticDiff } from "../../../../../../src/qa/static-signal/semantic-diff.ts";
import { extractPatterns } from "../../../../../../src/qa/static-signal/patterns.ts";

// The production extractor set, mirroring src/qa/static-signal/aggregate.defaults.ts. Each adapter
// receives the real extractor function; the composition root injects this whole set.
export const defaultExtractors: ExtractorSet = {
  symbols: new TreeSitterSymbolAdapter(extractSymbols),
  relations: new TreeSitterRelationAdapter(extractRelations),
  complexity: new LizardComplexityAdapter(extractComplexity),
  semanticDiff: new DifftasticSemanticDiffAdapter(extractSemanticDiff),
  patterns: new AstGrepPatternAdapter(extractPatterns),
};

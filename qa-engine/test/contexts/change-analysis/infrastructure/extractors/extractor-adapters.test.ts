import { test } from "node:test";
import assert from "node:assert/strict";
import { TreeSitterSymbolAdapter } from "@contexts/change-analysis/infrastructure/extractors/tree-sitter-symbol.adapter.ts";
import { TreeSitterRelationAdapter } from "@contexts/change-analysis/infrastructure/extractors/tree-sitter-relation.adapter.ts";
import { LizardComplexityAdapter } from "@contexts/change-analysis/infrastructure/extractors/lizard-complexity.adapter.ts";
import { DifftasticSemanticDiffAdapter } from "@contexts/change-analysis/infrastructure/extractors/difftastic-semantic-diff.adapter.ts";
import { AstGrepPatternAdapter } from "@contexts/change-analysis/infrastructure/extractors/ast-grep-pattern.adapter.ts";
import { isOk, isErr } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";

const ctx = { sha: Sha.of("abc1234"), repoDir: "/repo", changedFiles: ["a.ts"], diff: "d" };

test("symbol adapter delegates to the wrapped extractor and returns ok(symbols)", async () => {
  let calledFiles: string[] | null = null;
  const fake = async (files: string[], _repo: string) => { calledFiles = files; return [{ file: "a.ts", name: "f", kind: "function", signature: "f()", line: 1 }]; };
  const r = await new TreeSitterSymbolAdapter(fake).extract(ctx);
  assert.deepEqual(calledFiles, ["a.ts"]);
  assert.ok(isOk(r) && r.value.length === 1);
});

test("complexity adapter maps a thrown wrapped error to a typed ExtractorSkipped", async () => {
  const fake = async () => { throw new Error("lizard exploded"); };
  const r = await new LizardComplexityAdapter(fake).extract(ctx);
  assert.ok(isErr(r));
  assert.ok(isErr(r) && r.error.extractor === "complexity");
});

test("semantic-diff adapter passes diff + sha + baseSha through to the wrapped extractor", async () => {
  let seen: { diff?: string; sha?: string; base?: string } = {};
  const fake = async (diff: string, _repo: string, sha: string, base?: string) => { seen = { diff, sha, base }; return [{ file: "a.ts", cosmetic: false }]; };
  const r = await new DifftasticSemanticDiffAdapter(fake).extract({ ...ctx, baseSha: Sha.of("def5678") });
  assert.equal(seen.diff, "d");
  assert.equal(seen.sha, "abc1234");
  assert.equal(seen.base, "def5678");
  assert.ok(isOk(r));
});

test("relation adapter delegates to the wrapped extractor with files + repoDir (2-arg)", async () => {
  let calledWith: { files: string[]; repoDir: string } | null = null;
  const fake = async (files: string[], repoDir: string) => {
    calledWith = { files, repoDir };
    return [{ from: "a.ts", to: "b.ts", via: "import" }];
  };
  const r = await new TreeSitterRelationAdapter(fake).extract(ctx);
  assert.deepEqual(calledWith, { files: ["a.ts"], repoDir: "/repo" });
  assert.ok(isOk(r) && r.value.length === 1 && r.value[0]?.from === "a.ts");
});

test("pattern adapter delegates to the wrapped extractor with files + repoDir + diff (3-arg, per FIX 1 receives FILTERED files)", async () => {
  let calledWith: { files: string[]; repoDir: string; diff: string } | null = null;
  const fake = async (files: string[], repoDir: string, diff: string) => {
    calledWith = { files, repoDir, diff };
    return [{ file: "a.ts", pattern: "if-return", source: "ast-grep" as const }];
  };
  const r = await new AstGrepPatternAdapter(fake).extract(ctx);
  assert.deepEqual(calledWith, { files: ["a.ts"], repoDir: "/repo", diff: "d" });
  assert.ok(isOk(r) && r.value.length === 1 && r.value[0]?.pattern === "if-return");
});

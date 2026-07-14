// test/contexts/generation/infrastructure/context-assembler.adapter-parity.test.ts
// PARITY: call BOTH the wrapper and the legacy assemble/section on a shared section table;
// deepEqual the assembled text + sectionSizes, proving no field was dropped.
//
// migration-tier-4c Slice 5a: context-assembler.ts relocated from src/integrations/ into THIS SAME
// qa-engine tree (prompt-builders/) — there is no longer a separate "legacy src/" implementation to
// compare against; both imports below now resolve to the identical qa-engine module. This test is
// left in place (still green, still exercises the adapter) rather than deleted here — parity-test
// RETIREMENT is Slice 6's declared job (generation-ports-parity.test.ts and friends), not this
// relocation slice's. Kept excluded from the main qa-engine typecheck project (tsconfig.parity.json)
// per its pre-existing convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";
import { assemble as legacyAssemble, section as legacySection } from "@contexts/generation/infrastructure/prompt-builders/context-assembler.ts";

test("PARITY: assemble + section wrapper produces identical result to the legacy fn", () => {
  const adapter = new ContextAssemblerAdapter(legacyAssemble, legacySection);

  // Build sections via both paths using an arbitrary budget (NOT roleWindowBytes — catalog-independent)
  const BUDGET = 50_000;

  const legacyS1 = legacySection("task", "task", "write a login test for the flow", { priority: 1 });
  const legacyS2 = legacySection("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const legacyResult = legacyAssemble([legacyS1, legacyS2], { budgetBytes: BUDGET });

  const adapterS1 = adapter.section("task", "task", "write a login test for the flow", { priority: 1 });
  const adapterS2 = adapter.section("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const adapterResult = adapter.assemble([adapterS1, adapterS2], { budgetBytes: BUDGET });

  assert.equal(adapterResult.text, legacyResult.text, "assembled text must match the legacy fn");
  assert.deepEqual(adapterResult.sectionSizes, legacyResult.sectionSizes, "sectionSizes must match the legacy fn");
});

test("PARITY: budget shedding behavior matches the legacy fn", () => {
  const adapter = new ContextAssemblerAdapter(legacyAssemble, legacySection);

  // Use a very tight budget to trigger shedding — proves the shedding algorithm is delegated
  const TIGHT_BUDGET = 20; // very small: forces shedding

  const legacyS = legacySection("volatile-section", "volatile", "a very long volatile body to be shed", { priority: 99 });
  const legacyStable = legacySection("rules", "stable-prefix", "rules", { priority: 0 });
  const legacyResult = legacyAssemble([legacyS, legacyStable], { budgetBytes: TIGHT_BUDGET });

  const adapterS = adapter.section("volatile-section", "volatile", "a very long volatile body to be shed", { priority: 99 });
  const adapterStable = adapter.section("rules", "stable-prefix", "rules", { priority: 0 });
  const adapterResult = adapter.assemble([adapterS, adapterStable], { budgetBytes: TIGHT_BUDGET });

  assert.equal(adapterResult.text, legacyResult.text);
  assert.deepEqual(adapterResult.sectionSizes, legacyResult.sectionSizes);
});

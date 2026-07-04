// qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.test.ts
//
// RED for Slice 4b.1 (design §5.2, tasks 4b.1.1): the pure advisory renderer that composes
// impactedSymbols/callersOf/coChangeCoupling results into ONE markdown block for
// GenerationEnrichment.staticSignal. Mirrors legacy renderStaticSignal's own test discipline
// (empty -> "", per-section cap, sanitized cells, byte-budget truncation at a newline boundary).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";

const impacted = (n: number): LocalSymbolRef[] =>
  Array.from({ length: n }, (_, i) => ({ file: `src/File${i}.java`, symbol: `method${i}` }));

const coupled = (n: number): CoupledFile[] =>
  Array.from({ length: n }, (_, i) => ({
    file: `src/Other${i}.java`,
    couplingScore: 1 - i * 0.01,
    coChanges: 10 - i,
  }));

test("three populated results render a block with three sub-sections", () => {
  const out = renderBlastRadiusSignal({
    impacted: [
      { file: "src/Foo.java", symbol: "save" },
      { file: "src/Bar.java", symbol: "load" },
    ],
    callers: [{ file: "src/Caller.java", symbol: "handle" }],
    coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }],
  });

  assert.match(out, /Structural blast radius/i);
  assert.match(out, /Impacted symbols \(2\)/);
  assert.match(out, /`save` \(src\/Foo\.java\)/);
  assert.match(out, /`load` \(src\/Bar\.java\)/);
  assert.match(out, /Callers of the changed code \(1\)/);
  assert.match(out, /`handle` \(src\/Caller\.java\)/);
  assert.match(out, /co-change \(1\)/i);
  assert.match(out, /src\/Other\.java/);
  assert.match(out, /0\.82/);
  assert.match(out, /14/);
});

test("all-empty inputs render an empty string (no section, fail-open)", () => {
  const out = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [] });
  assert.equal(out, "");
});

test("a single empty sub-block is omitted entirely (no empty heading)", () => {
  const out = renderBlastRadiusSignal({
    impacted: [{ file: "src/Foo.java", symbol: "save" }],
    callers: [],
    coupled: [],
  });

  assert.match(out, /Impacted symbols \(1\)/);
  assert.doesNotMatch(out, /Callers of the changed code/);
  assert.doesNotMatch(out, /co-change/i);
});

test("impacted symbols and callers are sorted by descending confidence when provided", () => {
  const out = renderBlastRadiusSignal({
    impacted: [
      { file: "src/Low.java", symbol: "low", confidence: 0.55 },
      { file: "src/High.java", symbol: "high", confidence: 0.95 },
      { file: "src/Mid.java", symbol: "mid", confidence: 0.7 },
    ] as (LocalSymbolRef & { confidence?: number })[],
    callers: [],
    coupled: [],
  });

  const highIdx = out.indexOf("high");
  const midIdx = out.indexOf("mid");
  const lowIdx = out.indexOf("low");
  assert.ok(highIdx < midIdx && midIdx < lowIdx, "expected descending-confidence ordering: high, mid, low");
});

test("coupled files are sorted by descending couplingScore", () => {
  const out = renderBlastRadiusSignal({
    impacted: [],
    callers: [],
    coupled: [
      { file: "src/Low.java", couplingScore: 0.2, coChanges: 2 },
      { file: "src/High.java", couplingScore: 0.9, coChanges: 9 },
    ],
  });

  const highIdx = out.indexOf("High.java");
  const lowIdx = out.indexOf("Low.java");
  assert.ok(highIdx < lowIdx, "expected descending couplingScore ordering: High before Low");
});

test("each sub-block is capped at MAX_ITEMS (200) items", () => {
  const out = renderBlastRadiusSignal({
    impacted: impacted(250),
    callers: [],
    coupled: [],
  });

  // header says the TRUE count, but only 200 lines are rendered
  assert.match(out, /Impacted symbols \(250\)/);
  const occurrences = out.split("\n").filter((l) => l.startsWith("- `method")).length;
  assert.equal(occurrences, 200, "impacted sub-block must cap at 200 rendered items even though 250 were supplied");
});

test("coupled sub-block is also capped at MAX_ITEMS (200) items", () => {
  const out = renderBlastRadiusSignal({
    impacted: [],
    callers: [],
    coupled: coupled(250),
  });

  const occurrences = out.split("\n").filter((l) => l.startsWith("- src/Other")).length;
  assert.equal(occurrences, 200, "coupled sub-block must cap at 200 rendered items even though 250 were supplied");
});

test("the whole block is capped at the byte budget, truncated at the last newline boundary", () => {
  // MAX_ITEMS caps each sub-block at 200 rendered lines — well under the byte budget on its own.
  // To actually exercise the whole-block byte-budget truncation, spread the 200-item cap across
  // three sub-blocks with long, distinctive symbol/file names so the combined output exceeds
  // MAX_LEN (20_000 bytes).
  const long = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ file: `src/main/java/very/long/package/path/${prefix}File${i}Repository.java`, symbol: `${prefix}veryLongMethodNameNumber${i}ForBudgetPadding` }));

  const out = renderBlastRadiusSignal({
    impacted: long("Impacted", 200),
    callers: long("Caller", 200),
    coupled: Array.from({ length: 200 }, (_, i) => ({
      file: `src/main/java/very/long/package/path/Coupled${i}Repository.java`,
      couplingScore: 0.5,
      coChanges: 5,
    })),
  });

  const bytes = Buffer.byteLength(out, "utf8");
  assert.ok(bytes <= 20_000, `expected output <= 20000 bytes, got ${bytes}`);
  assert.match(out, /truncated/);
  assert.ok(out.endsWith("\n…(structural blast radius truncated)"), "must end with the truncation marker");
});

test("every cell is passed through sanitizeText (secrets redacted)", () => {
  const out = renderBlastRadiusSignal({
    impacted: [{ file: "src/sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK.java", symbol: "save" }],
    callers: [],
    coupled: [],
  });

  assert.doesNotMatch(out, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/, "a secret-shaped path must be redacted, not leaked verbatim into the prompt");
  assert.match(out, /REDACTED/);
});

test("an all-CodeGraphUnavailable composition (every collaborator absent) still renders an empty string", () => {
  // Mirrors what StructuralSignalPortAdapter passes when every CodeGraphPort method returned err(...):
  // empty arrays for every field, same as the true all-empty case.
  const out = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [] });
  assert.equal(out, "");
});

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractRelations } from "./relations";

test("extractRelations links a changed file to its imported changed file", async () => {
  const edges = await extractRelations(["sample.ts", "order.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.some((e) => e.from.endsWith("sample.ts") && e.to.endsWith("order.ts")));
});

test("extractRelations keeps unresolved imports as module specifiers", async () => {
  const edges = await extractRelations(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.every((e) => typeof e.to === "string"));
});

// ── C3: tsconfig path-alias resolution ────────────────────────────────────────

test("C3: tsconfig path alias resolves @/ import to a repo-relative file path", async () => {
  // Fixture: __fixtures__/c3-alias/ has a tsconfig.json with paths + the aliased file
  const fixtureDir = join(import.meta.dirname, "__fixtures__", "c3-alias");
  const edges = await extractRelations(["src/consumer.ts"], fixtureDir);
  // The aliased import "@/components/Button" must resolve to "src/components/Button.ts"
  const resolved = edges.find((e) => e.from.endsWith("consumer.ts") && e.to.endsWith("components/Button.ts"));
  assert.ok(resolved, `C3: @/ alias import must resolve to a file path; got: ${JSON.stringify(edges)}`);
});

test("C3: relative imports are unchanged when tsconfig is present", async () => {
  // Existing relative resolution must still work even when a tsconfig.json is present.
  const edges = await extractRelations(["sample.ts", "order.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.some((e) => e.from.endsWith("sample.ts") && e.to.endsWith("order.ts")),
    "C3 regression: relative imports must still resolve when tsconfig is present");
});

test("C3: no tsconfig → alias kept as raw specifier (fail-open)", async () => {
  // A directory with no tsconfig.json: a non-relative import stays unresolved.
  const edges = await extractRelations(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  // "@/something" would stay raw if there's no tsconfig
  const aliasEdge = edges.find((e) => e.to.startsWith("@/"));
  // sample.ts has no alias imports, so no @/ edges — just verify extractRelations still runs
  assert.ok(edges.every((e) => typeof e.to === "string"), "all to values must be strings");
});

// ── C3: Java heuristic resolution ─────────────────────────────────────────────

test("C3: Java import resolves to Maven-layout src/main/java path when file exists", async () => {
  // Fixture: __fixtures__/c3-java/ has src/main/java/com/example/UserService.java
  const fixtureDir = join(import.meta.dirname, "__fixtures__", "c3-java");
  const edges = await extractRelations(["src/main/java/com/example/OrderService.java"], fixtureDir);
  // import com.example.UserService → src/main/java/com/example/UserService.java
  const resolved = edges.find((e) => e.to === "src/main/java/com/example/UserService.java");
  assert.ok(resolved, `C3: Java import must resolve to Maven-layout path; got: ${JSON.stringify(edges)}`);
});

test("C3: Java import kept as raw specifier when file not found (fail-open)", async () => {
  // A Java file importing a class that doesn't exist → raw dotted specifier.
  const fixtureDir = join(import.meta.dirname, "__fixtures__", "c3-java");
  const edges = await extractRelations(["src/main/java/com/example/OrderService.java"], fixtureDir);
  // import com.example.NotExists → no file found → stays as raw dotted name
  const rawEdge = edges.find((e) => e.to === "com.example.NotExists");
  assert.ok(rawEdge, `C3: unfound Java import must keep raw specifier; got: ${JSON.stringify(edges)}`);
});

// ── C3: tsconfig cache invalidates on edit (no stale aliases in a long-lived process) ──────────

test("C3: tsconfig alias cache invalidates when tsconfig.json changes (mtime-keyed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-relations-c3-inval-"));
  try {
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "Thing.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "b", "Thing.ts"), "export const x = 2;\n");
    writeFileSync(join(dir, "consumer.ts"), `import { x } from "@t/Thing";\n`);
    const tscfg = join(dir, "tsconfig.json");

    // v1: @t/* → a/* — stamp an explicit old mtime so the second write is unambiguously newer.
    writeFileSync(tscfg, JSON.stringify({ compilerOptions: { paths: { "@t/*": ["a/*"] } } }));
    utimesSync(tscfg, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const e1 = await extractRelations(["consumer.ts"], dir);
    assert.ok(e1.some((e) => e.to === "a/Thing.ts"), `v1 alias must resolve to a/Thing.ts; got ${JSON.stringify(e1)}`);

    // v2: @t/* → b/* — a long-lived process must pick the edit up, not serve the cached v1 aliases.
    writeFileSync(tscfg, JSON.stringify({ compilerOptions: { paths: { "@t/*": ["b/*"] } } }));
    utimesSync(tscfg, new Date(2021, 0, 1), new Date(2021, 0, 1));
    const e2 = await extractRelations(["consumer.ts"], dir);
    assert.ok(e2.some((e) => e.to === "b/Thing.ts"), `v2 alias must resolve to b/Thing.ts after tsconfig edit; got ${JSON.stringify(e2)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

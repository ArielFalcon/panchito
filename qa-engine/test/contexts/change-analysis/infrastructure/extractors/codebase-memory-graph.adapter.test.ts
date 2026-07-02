// Behavioral tests for CodebaseMemoryGraphAdapter — implements ComplexityExtractorPort against
// the real captured `query_graph`+Cypher response shape (design §6.2, §10 Slice-2b step 1).
//
// The client is constructor-injected as a FAKE (never spawns a real process); these tests exercise
// the adapter's OWN logic only: column-name->index resolution, guarded string->number coercion,
// row->VO mapping (including the new ADR-5 `cognitive` field), file-path filtering, and the
// three-outcome degrade contract (ExtractorSkipped / legitimate ok([]) / ok(hotspots)).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CodebaseMemoryResult } from "../../../../../src/shared-infrastructure/code-graph/codebase-memory-client.ts";
import { CodebaseMemoryGraphAdapter } from "../../../../../src/contexts/change-analysis/infrastructure/extractors/codebase-memory-graph.adapter.ts";
import type { ExtractionContext } from "../../../../../src/contexts/change-analysis/application/ports/index.ts";

const fixturePath = fileURLToPath(new URL("./__fixtures__/codebase-memory-complexity.json", import.meta.url));
const fixtureRaw = readFileSync(fixturePath, "utf8");

// Minimal stand-in for CodebaseMemoryClient — the adapter only calls `.cli(...)`, so a fake
// exposing that one method (typed structurally against the real client) is sufficient DI.
class FakeClient {
  constructor(private readonly result: () => Promise<CodebaseMemoryResult>) {}
  public lastArgs: { tool: string; jsonArg: string; repoDir: string } | null = null;
  async cli(tool: string, jsonArg: string, repoDir: string): Promise<CodebaseMemoryResult> {
    this.lastArgs = { tool, jsonArg, repoDir };
    return this.result();
  }
}

function baseCtx(changedFiles: string[]): ExtractionContext {
  return {
    sha: { value: "deadbeef" } as ExtractionContext["sha"],
    repoDir: "/repo",
    changedFiles,
    diff: "",
  };
}

test("extract() maps every real fixture row to a ComplexityHotspot, including the new cognitive field", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: fixtureRaw, stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const changedFiles = [
    "src/main/java/es/name/restaurants/infraestructure/mappers/place/PlaceInfrastructureMapper.java",
  ];
  const result = await adapter.extract(baseCtx(changedFiles));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1, "only the changed file's row should survive filtering");
  const hotspot = result.value[0]!;
  assert.equal(hotspot.file, "src/main/java/es/name/restaurants/infraestructure/mappers/place/PlaceInfrastructureMapper.java");
  assert.equal(hotspot.function, "stringToIntegerSafe");
  assert.equal(hotspot.ccn, 3, "ccn <- Number(m.complexity)");
  assert.equal(hotspot.cognitive, 4, "cognitive <- Number(m.cognitive), ADR-5 value-add");
  assert.equal(hotspot.line, 82, "line <- Number(m.start_line), a REAL non-zero value (R6 resolved)");
  assert.equal(hotspot.nloc, 11, "nloc <- Number(m.lines) — the documented lines!=nloc fidelity approximation");
});

test("documents the lines!=nloc fidelity caveat: nloc is m.lines (total span), not lizard's comment/blank-excluded nloc", async () => {
  // Same row as above: m.start_line=82, m.end_line=92, m.lines=11 (=92-82+1, inclusive span).
  // This is a REAL, non-zero, monotonic-with-size value — but a DIFFERENT metric than lizard's
  // nloc (lines of code, excluding blanks/comments). Documented per design §8 R6.
  const client = new FakeClient(async () => ({ code: 0, stdout: fixtureRaw, stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const changedFiles = [
    "src/main/java/es/name/restaurants/infraestructure/mappers/place/PlaceInfrastructureMapper.java",
  ];
  const result = await adapter.extract(baseCtx(changedFiles));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const hotspot = result.value[0]!;
  assert.equal(hotspot.nloc, 11, "nloc is the m.lines approximation, not a lizard-equivalent LOC count");
});

test("extract() resolves columns by NAME, not fixed position — a reordered columns array still maps correctly", async () => {
  const reordered = {
    columns: ["m.file_path", "m.name", "m.cognitive", "m.complexity", "m.lines", "m.start_line", "m.end_line"],
    rows: [["a/B.java", "foo", "9", "6", "20", "50", "69"]],
    total: 1,
  };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(reordered), stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["a/B.java"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const hotspot = result.value[0]!;
  assert.equal(hotspot.ccn, 6, "ccn must resolve to the m.complexity column regardless of position");
  assert.equal(hotspot.cognitive, 9, "cognitive must resolve to the m.cognitive column regardless of position");
  assert.equal(hotspot.line, 50, "line must resolve to the m.start_line column regardless of position");
  assert.equal(hotspot.nloc, 20, "nloc must resolve to the m.lines column regardless of position");
});

test("extract() filters rows to ctx.changedFiles by the m.file_path column", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: fixtureRaw, stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  // A file present in the fixture that is NOT in changedFiles must be excluded.
  const result = await adapter.extract(baseCtx(["some/unrelated/File.java"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, [], "no row matches an unrelated changed file — legitimate empty");
});

test("extract() returns ok([]) — a legitimate empty result — when ctx.changedFiles is empty, with no spawn", async () => {
  const client = new FakeClient(async () => {
    throw new Error("must not spawn when changedFiles is empty");
  });
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx([]));
  assert.deepEqual(result, { ok: true, value: [] });
});

test("extract() returns ok([]) — legitimate empty, not ExtractorSkipped — when the graph responds successfully with zero rows", async () => {
  const empty = { columns: ["m.name", "m.file_path", "m.complexity", "m.cognitive", "m.start_line", "m.end_line", "m.lines"], rows: [], total: 0 };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(empty), stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["any/file.java"]));
  assert.deepEqual(result, { ok: true, value: [] });
});

test("extract() returns ExtractorSkipped when the client degrades with code:null (binary missing/timeout)", async () => {
  const client = new FakeClient(async () => ({ code: null, stdout: "", stderr: "codebase-memory-mcp ENOENT" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["any/file.java"]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.extractor, "complexity", "same extractor label as LizardComplexityAdapter, so a downstream consumer routes both the same way");
  assert.match(result.error.reason, /ENOENT/);
});

test("extract() returns ExtractorSkipped on JSON parse failure — a whole-extraction degrade, never a throw", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: "not valid json {{{", stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["any/file.java"]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.extractor, "complexity");
  assert.ok(result.error.reason.length > 0, "reason must be non-empty, never a silent blank degrade");
});

test("extract() returns ExtractorSkipped when the payload is not a {columns,rows} shape", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ nodes: [] }), stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["any/file.java"]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.extractor, "complexity");
});

test("extract() drops a single row with a non-numeric complexity cell (per-row degrade), without failing the whole extraction", async () => {
  const mixed = {
    columns: ["m.name", "m.file_path", "m.complexity", "m.cognitive", "m.start_line", "m.end_line", "m.lines"],
    rows: [
      ["goodFn", "a/File.java", "5", "6", "10", "20", "11"],
      ["badFn", "a/File.java", "not-a-number", "3", "30", "40", "11"],
    ],
    total: 2,
  };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(mixed), stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  const result = await adapter.extract(baseCtx(["a/File.java"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1, "the malformed row is dropped, not the whole extraction");
  assert.equal(result.value[0]!.function, "goodFn");
});

test("extract() calls client.cli with tool='query_graph' and the repoDir from ctx", async () => {
  const empty = { columns: ["m.name", "m.file_path", "m.complexity", "m.cognitive", "m.start_line", "m.end_line", "m.lines"], rows: [], total: 0 };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(empty), stderr: "" }));
  const adapter = new CodebaseMemoryGraphAdapter(client as never);
  await adapter.extract(baseCtx(["a/File.java"]));
  assert.equal(client.lastArgs?.tool, "query_graph");
  assert.equal(client.lastArgs?.repoDir, "/repo");
});

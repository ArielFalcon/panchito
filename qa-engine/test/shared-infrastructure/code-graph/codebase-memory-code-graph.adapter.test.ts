// qa-engine/test/shared-infrastructure/code-graph/codebase-memory-code-graph.adapter.test.ts
// Behavioral tests for CodebaseMemoryCodeGraphAdapter — the REAL CodeGraphPort implementation for
// Phase 4 (design §2, §3, §4, §8 Slice 4a; ADR-1, ADR-5). Scope of THIS slice (4a-i, per the
// orchestrator's review split): the adapter skeleton, the safe literal-inlining helper, row parsing,
// the confidence floor, and `impactedSymbols` ONLY. `coChangeCoupling`/`callersOf` stay inert
// `ok([])` stubs — implemented in slice 4a-ii — so any assertion in THIS file about those two methods
// only checks the inert-stub contract, never real graph data (spec §2 non-requirements, Scenario K).
//
// The client is injected as a FAKE (never spawns a real process) — mirrors the sibling
// CodebaseMemoryGraphAdapter test's own DI pattern exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOk, isErr } from "@kernel/result.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import type { CodebaseMemoryResult } from "../../../src/shared-infrastructure/code-graph/codebase-memory-client.ts";
import {
  CodebaseMemoryCodeGraphAdapter,
  inlineList,
  inlineLiteral,
} from "../../../src/shared-infrastructure/code-graph/codebase-memory-code-graph.adapter.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

// Minimal stand-in for CodebaseMemoryClient — the adapter only calls `.cli(...)`.
class FakeClient {
  public calls: { tool: string; jsonArg: string; repoDir: string }[] = [];
  constructor(private readonly result: () => Promise<CodebaseMemoryResult>) {}
  async cli(tool: string, jsonArg: string, repoDir: string): Promise<CodebaseMemoryResult> {
    this.calls.push({ tool, jsonArg, repoDir });
    return this.result();
  }
}

function blast(files: string[]): BlastRadius {
  return BlastRadius.of(Sha.of("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), files);
}

// ---------------------------------------------------------------------------------------------
// 4a.1 — adapter skeleton + safe early-return
// ---------------------------------------------------------------------------------------------

test("impactedSymbols returns ok([]) for an EMPTY BlastRadius WITHOUT calling client.cli", async () => {
  const client = new FakeClient(async () => {
    throw new Error("must not spawn when the BlastRadius is empty");
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast([]), { depth: 3 });
  assert.deepEqual(result, { ok: true, value: [] });
  assert.equal(client.calls.length, 0, "no CLI spawn should happen for an empty BlastRadius");
});

test("coChangeCoupling stays an inert ok([]) stub in this slice (4a-ii implements it)", async () => {
  const client = new FakeClient(async () => {
    throw new Error("coChangeCoupling must not spawn in slice 4a-i");
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.coChangeCoupling("/repo", ["a.java", "b.java"]);
  assert.deepEqual(result, { ok: true, value: [] });
  assert.equal(client.calls.length, 0);
});

test("callersOf stays an inert ok([]) stub in this slice (4a-ii implements it)", async () => {
  const client = new FakeClient(async () => {
    throw new Error("callersOf must not spawn in slice 4a-i");
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.callersOf("/repo", { file: "a.java", symbol: "foo" }, 2);
  assert.deepEqual(result, { ok: true, value: [] });
  assert.equal(client.calls.length, 0);
});

test("existingCoverage and structurallyRelated stay inert ok([]) — never promoted to real graph data (Scenario K)", async () => {
  const client = new FakeClient(async () => {
    throw new Error("must not spawn — these methods are out of scope for this change entirely");
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["a.java"]);
  const coverage = await adapter.existingCoverage("/repo", changed);
  const related = await adapter.structurallyRelated("/repo", [{ file: "a.java", symbol: "foo" }]);
  assert.deepEqual(coverage, { ok: true, value: [] });
  assert.deepEqual(related, { ok: true, value: [] });
  assert.equal(client.calls.length, 0);
});

test("syncTo spawns index_repository and maps a whole-index client degrade to err(IndexFailed) — never called by this slice's use-case wiring, but implemented+tested per design §6/R11", async () => {
  const client = new FakeClient(async () => ({ code: null, stdout: "", stderr: "codebase-memory-mcp ENOENT" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.syncTo("/repo", ["a.java"]);
  assert.equal(isErr(result), true);
  if (result.ok) return;
  assert.match(result.error.reason, /ENOENT/);
  assert.equal(client.calls[0]?.tool, "index_repository");
});

test("syncTo resolves ok({nodeCount}) on a successful index_repository response", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ node_count: 42 }), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.syncTo("/repo", ["a.java"]);
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  assert.equal(result.value.nodeCount, 42);
});

// ---------------------------------------------------------------------------------------------
// 4a.2 — safe literal inlining (inlineList / inlineLiteral) — net-new, §3.0
// ---------------------------------------------------------------------------------------------

test("inlineLiteral escapes an embedded single quote and wraps in single quotes", () => {
  assert.equal(inlineLiteral("a'b.java"), "'a\\'b.java'");
});

test("inlineLiteral escapes a trailing backslash before wrapping", () => {
  assert.equal(inlineLiteral("a\\"), "'a\\\\'");
});

test("inlineLiteral round-trips a normal git-path-shaped string unchanged (just quoted)", () => {
  assert.equal(
    inlineLiteral("src/main/java/es/name/restaurants/Foo.java"),
    "'src/main/java/es/name/restaurants/Foo.java'",
  );
});

test("inlineLiteral rejects a value containing a newline — returns null (dropped, not injected)", () => {
  assert.equal(inlineLiteral("a\nb.java"), null);
});

test("inlineLiteral rejects a value containing a control character — returns null", () => {
  assert.equal(inlineLiteral("a\x00b.java"), null);
  assert.equal(inlineLiteral("a\tb.java"), null);
});

test("inlineList joins escaped values into a Cypher list literal", () => {
  assert.equal(inlineList(["a.java", "b'c.java"]), "['a.java','b\\'c.java']");
});

test("inlineList drops a control-char/newline value from the list, keeping the rest", () => {
  assert.equal(inlineList(["a.java", "bad\nvalue", "c.java"]), "['a.java','c.java']");
});

test("inlineList returns null when EVERY value is dropped — caller short-circuits without issuing a query", () => {
  assert.equal(inlineList(["\n", "\x01"]), null);
});

test("inlineList returns null for an empty input array", () => {
  assert.equal(inlineList([]), null);
});

test("the escape transform is total/idempotent-safe for every string composed of only '\\' and \"'\" chars, any order/count up to length 4", () => {
  const alphabet = ["\\", "'"];
  const strings: string[] = [""];
  for (let len = 1; len <= 4; len++) {
    const level: string[] = [];
    for (const prefix of strings.filter((s) => s.length === len - 1)) {
      for (const ch of alphabet) level.push(prefix + ch);
    }
    strings.push(...level);
  }
  for (const raw of strings) {
    const escaped = inlineLiteral(raw);
    assert.notEqual(escaped, null, `must never reject a string of only \\ and ' chars: ${JSON.stringify(raw)}`);
    const body = escaped!.slice(1, -1); // strip the wrapping quotes
    // Structural invariant (design §3.0): every raw backslash is doubled, every raw quote is
    // preceded by exactly one (now-doubled-context) backslash in the output.
    let i = 0;
    let rawIdx = 0;
    while (i < body.length) {
      if (body[i] === "\\" && body[i + 1] === "\\") {
        assert.equal(raw[rawIdx], "\\", `expected a raw backslash at index ${rawIdx} of ${JSON.stringify(raw)}`);
        i += 2;
        rawIdx += 1;
      } else if (body[i] === "\\" && body[i + 1] === "'") {
        assert.equal(raw[rawIdx], "'", `expected a raw quote at index ${rawIdx} of ${JSON.stringify(raw)}`);
        i += 2;
        rawIdx += 1;
      } else {
        throw new Error(`unexpected unescaped character in output body: ${JSON.stringify(body)} at ${i}`);
      }
    }
    assert.equal(rawIdx, raw.length, "every raw character must be accounted for exactly once");
    // The produced literal must be well-formed: starts/ends with a single unescaped quote.
    assert.equal(escaped![0], "'");
    assert.equal(escaped![escaped!.length - 1], "'");
  }
});

// ---------------------------------------------------------------------------------------------
// 4a.3 — parsing / degrade contract
// ---------------------------------------------------------------------------------------------

test("impactedSymbols returns err(CodeGraphUnavailable) when the client degrades with code:null BEFORE any JSON parsing", async () => {
  const client = new FakeClient(async () => ({ code: null, stdout: "not even json", stderr: "ENOENT" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.equal(isErr(result), true);
  if (result.ok) return;
  assert.match(result.error.reason, /ENOENT/);
});

test("impactedSymbols returns err(CodeGraphUnavailable) on invalid JSON stdout", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: "not valid json {{{", stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.equal(isErr(result), true);
});

test("impactedSymbols returns err(CodeGraphUnavailable) when the payload is missing columns/rows", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ nodes: [] }), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.equal(isErr(result), true);
});

test("impactedSymbols returns ok([]) — legitimate empty — when the graph responds successfully with zero rows", async () => {
  const empty = { columns: ["a_file", "a_name", "b_name", "b_file", "r1_conf"], rows: [], total: 0 };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(empty), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.deepEqual(result, { ok: true, value: [] });
});

// ---------------------------------------------------------------------------------------------
// 4a.4 — confidence floor (§4.1)
// ---------------------------------------------------------------------------------------------

function outboundRow(bName: string, bFile: string, conf: string) {
  return ["a/File.java", "anchorFn", bName, bFile, conf, "", "", ""];
}

test("impactedSymbols excludes edges below the default 0.55 floor and includes 0.55/0.72/0.90 when minConfidence is omitted", async () => {
  const outboundCols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const payload = {
    columns: outboundCols,
    rows: [
      outboundRow("low1", "b1.java", "0.30"),
      outboundRow("low2", "b2.java", "0.54"),
      outboundRow("mid", "b3.java", "0.55"),
      outboundRow("high1", "b4.java", "0.72"),
      outboundRow("high2", "b5.java", "0.90"),
    ],
    total: 5,
  };
  const empty = { columns: outboundCols, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    // First call = outbound (has data), second = inbound (empty) — order per design §3.1.
    return { code: 0, stdout: JSON.stringify(call === 1 ? payload : empty), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a/File.java"]), { depth: 1 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  const names = result.value.map((s) => s.symbol).sort();
  assert.deepEqual(names, ["high1", "high2", "mid"]);
});

test("impactedSymbols honors an explicit minConfidence override (0.85) — only 0.90 survives", async () => {
  const outboundCols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const payload = {
    columns: outboundCols,
    rows: [
      outboundRow("mid", "b3.java", "0.55"),
      outboundRow("high1", "b4.java", "0.72"),
      outboundRow("high2", "b5.java", "0.90"),
    ],
    total: 3,
  };
  const empty = { columns: outboundCols, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: JSON.stringify(call === 1 ? payload : empty), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a/File.java"]), { depth: 1, minConfidence: 0.85 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((s) => s.symbol), ["high2"]);
});

test("impactedSymbols drops a row whose confidence cell is missing/non-numeric (never included as NaN)", async () => {
  const outboundCols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const payload = {
    columns: outboundCols,
    rows: [outboundRow("missingConf", "b6.java", ""), outboundRow("goodConf", "b7.java", "0.85")],
    total: 2,
  };
  const empty = { columns: outboundCols, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: JSON.stringify(call === 1 ? payload : empty), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a/File.java"]), { depth: 1 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((s) => s.symbol), ["goodConf"]);
});

// ---------------------------------------------------------------------------------------------
// 4a.5 — impactedSymbols: literal outbound/inbound queries + anchor resolution (§3.1, §4.2)
// ---------------------------------------------------------------------------------------------

test("impl-node anchor resolution: a changed file = the IMPL file yields a NON-EMPTY outbound result via the impl's real outgoing CALLS (Scenario C)", async () => {
  const outbound = JSON.parse(fixture("impacted-outbound.json"));
  const emptyInbound = { columns: outbound.columns, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(outbound) : JSON.stringify(emptyInbound), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 2 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  assert.ok(result.value.length > 0, "must be non-empty: proves anchoring did not land on a bodyless interface node");
  assert.ok(
    result.value.some((s) => s.symbol === "save" && s.file.includes("CourseRepositoryPort")),
    "the impl's real hop-1 CALLS edge (createNewCourse -> save) must be present",
  );
});

test("interface-only changed file (no outgoing CALLS) legitimately yields ok([]) outbound — documented degrade, not a bug", async () => {
  const emptyCols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const empty = { columns: emptyCols, rows: [], total: 0 };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(empty), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/application/service/CourseApplicationService.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 1 });
  assert.deepEqual(result, { ok: true, value: [] });
});

test("overloaded name in one file: BOTH matching start nodes' reachable sets union (advisory breadth, not deduped away)", async () => {
  const cols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const payload = {
    columns: cols,
    rows: [
      ["shared/File.java", "overloadedFn", "calleeOne", "b1.java", "0.85", "", "", ""],
      ["shared/File.java", "overloadedFn", "calleeTwo", "b2.java", "0.85", "", "", ""],
    ],
    total: 2,
  };
  const empty = { columns: cols, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(payload) : JSON.stringify(empty), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["shared/File.java"]), { depth: 1 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  const names = result.value.map((s) => s.symbol).sort();
  assert.deepEqual(names, ["calleeOne", "calleeTwo"]);
});

test("depth>=2 intermediate-hop interface/impl-split: the traversal degrades to the correctly-truncated result, never a fabricated superset (REAL fixture)", async () => {
  const outbound = JSON.parse(fixture("impacted-outbound.json"));
  const emptyInbound = { columns: outbound.columns, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(outbound) : JSON.stringify(emptyInbound), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 2 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  // createNewCourse -> save (hop1, real edge) -> [nothing] (hop2: save is the bodyless interface
  // method, zero real outgoing CALLS — hand-verified against real Java source). The truncation
  // must NOT be papered over with a fabricated hop-2 symbol.
  const saveEntry = result.value.find((s) => s.symbol === "save" && s.file.includes("CourseRepositoryPort"));
  assert.ok(saveEntry, "hop-1 'save' must be present (the real, non-truncated edge)");
  // No hop-2 symbol should exist that isn't independently backed by its own row in the fixture.
  const fabricatedFromSave = result.value.filter((s) => s.file === "" || s.symbol === "");
  assert.equal(fabricatedFromSave.length, 0, "an empty c_name/c_file cell must never become a fabricated symbol");
});

test("Lombok/accessor-only anchor: zero CALLS edges returns a legitimate ok([]), never miscast as a positive 'no dependency' claim (R7, §4.3)", async () => {
  const cols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const empty = { columns: cols, rows: [], total: 0 };
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify(empty), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/domain/model/course/CourseModel.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 1 });
  assert.deepEqual(result, { ok: true, value: [] }, "ok([]) is a VALID Result, not an error");
});

test("impactedSymbols dedupes the outbound+inbound union by (file, symbol) and excludes the anchor nodes", async () => {
  const cols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const outbound = {
    columns: cols,
    rows: [["anchor.java", "anchorFn", "shared", "shared.java", "0.85", "", "", ""]],
    total: 1,
  };
  const inboundCols = ["a_file", "a_name", "b_name", "b_file", "r1_conf", "c_name", "c_file", "r2_conf"];
  const inbound = {
    columns: inboundCols,
    rows: [["anchor.java", "anchorFn", "shared", "shared.java", "0.85", "", "", ""]],
    total: 1,
  };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(outbound) : JSON.stringify(inbound), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["anchor.java"]), { depth: 1 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1, "the same (file,symbol) reached via both directions must be deduped to one entry");
  assert.deepEqual(result.value[0], { file: "shared.java", symbol: "shared" });
});

test("either sub-query (outbound or inbound) returning CodeGraphUnavailable short-circuits the whole method to that error — never a silent partial ok([])", async () => {
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    if (call === 1) return { code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" };
    return { code: null, stdout: "", stderr: "inbound query crashed" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const result = await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.equal(isErr(result), true);
  if (result.ok) return;
  assert.match(result.error.reason, /inbound query crashed/);
});

// ---------------------------------------------------------------------------------------------
// R6 — no variable-length CALLS* Cypher, explicit unrolled hops per depth
// ---------------------------------------------------------------------------------------------

test("depth:1/2/3 each produce the expected explicit hop-count in the literal query text — never a variable-length CALLS* pattern", async () => {
  for (const depth of [1, 2, 3] as const) {
    const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" }));
    const adapter = new CodebaseMemoryCodeGraphAdapter(client);
    await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth });
    assert.ok(client.calls.length >= 1, "must issue at least the outbound query");
    for (const call of client.calls) {
      const parsed = JSON.parse(call.jsonArg) as { query: string };
      assert.doesNotMatch(parsed.query, /CALLS\*/, "must never emit a variable-length CALLS* pattern");
      const callsHopCount = (parsed.query.match(/:CALLS/g) ?? []).length;
      assert.equal(callsHopCount, depth, `depth=${depth} must unroll to exactly ${depth} explicit CALLS hops`);
    }
  }
});

test("the generated depth-2 outbound query text matches the fixture's captured _provenance.query BYTE-FOR-BYTE (modulo newline separators)", async () => {
  // The fresh review caught an off-by-one in buildHopQuery's hop chaining that every other test
  // structurally missed: the FakeClient returns fixture rows regardless of the query text, and the
  // hop-count regex only counts `:CALLS` occurrences without checking which variables each clause
  // binds. THIS test closes that gap — the full generated query must reproduce, character for
  // character, the exact query that was actually run against the real binary when the fixture was
  // captured (stored in its _provenance.query). Any drift in chaining/aliases/anchoring fails here.
  const provenance = (JSON.parse(fixture("impacted-outbound.json")) as { _provenance: { query: string } })._provenance;
  const client = new FakeClient(async () => ({ code: 0, stdout: fixture("impacted-outbound.json"), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client, "Users-arielyumn-Desktop-TRABAJO-nname-ms-name-restaurants");
  await adapter.impactedSymbols(
    "/repo",
    blast(["src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java"]),
    { depth: 2 },
  );
  assert.ok(client.calls.length >= 1, "must issue the outbound query first");
  const outbound = JSON.parse(client.calls[0]!.jsonArg) as { query: string };
  assert.equal(
    outbound.query.replace(/\n/g, " "),
    provenance.query,
    "the generated outbound query must match the fixture's captured provenance query exactly",
  );
});

test("out-of-range depth is clamped to the supported 1..3 range — never splices 'undefined' into the query", async () => {
  // hopVars supports depth <= 3; an unclamped depth >= 4 would index past the array and emit the
  // literal string "undefined" into live Cypher. depth <= 0 must clamp up to a single hop.
  for (const [requested, expectedHops] of [
    [5, 3],
    [4, 3],
    [0, 1],
    [-2, 1],
  ] as const) {
    const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" }));
    const adapter = new CodebaseMemoryCodeGraphAdapter(client);
    await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: requested });
    assert.ok(client.calls.length >= 1);
    for (const call of client.calls) {
      const parsed = JSON.parse(call.jsonArg) as { query: string };
      assert.doesNotMatch(parsed.query, /undefined/, `depth=${requested} must never splice 'undefined' into the query`);
      const callsHopCount = (parsed.query.match(/:CALLS/g) ?? []).length;
      assert.equal(callsHopCount, expectedHops, `depth=${requested} must clamp to ${expectedHops} hops`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// R8 / Scenario F — CLI request shape: project key + query key (never cypher), across all calls
// ---------------------------------------------------------------------------------------------

test("every cli() call this adapter makes for impactedSymbols passes a jsonArg with a project key and a query key (never cypher)", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client, "my-project");
  await adapter.impactedSymbols("/repo", blast(["a.java"]), { depth: 1 });
  assert.ok(client.calls.length > 0);
  for (const call of client.calls) {
    const parsed = JSON.parse(call.jsonArg) as Record<string, unknown>;
    assert.equal(typeof parsed["project"], "string");
    assert.ok(parsed["project"], "project key must be present and non-empty");
    assert.equal(typeof parsed["query"], "string");
    assert.equal(parsed["cypher"], undefined, "must never use a `cypher` key");
  }
});

test("impactedSymbols anchors WHERE file_path IN [...] with the inlined changed files in every literal query", async () => {
  const client = new FakeClient(async () => ({ code: 0, stdout: JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" }));
  const adapter = new CodebaseMemoryCodeGraphAdapter(client, "my-project");
  await adapter.impactedSymbols("/repo", blast(["src/a.java", "src/b.java"]), { depth: 1 });
  for (const call of client.calls) {
    const parsed = JSON.parse(call.jsonArg) as { query: string };
    assert.match(parsed.query, /file_path IN \[/);
    assert.match(parsed.query, /'src\/a\.java'/);
    assert.match(parsed.query, /'src\/b\.java'/);
  }
});

// ---------------------------------------------------------------------------------------------
// 4a.9 — ground-truth accuracy characterization (§7, ADR-6, R13, Scenario J)
// ---------------------------------------------------------------------------------------------

interface Ref { file: string; symbol: string }

function precisionRecall(predicted: Ref[], truth: Ref[]): { precision: number; recall: number } {
  const key = (r: Ref) => `${r.file}::${r.symbol}`;
  const predictedSet = new Set(predicted.map(key));
  const truthSet = new Set(truth.map(key));
  let intersection = 0;
  for (const k of predictedSet) if (truthSet.has(k)) intersection += 1;
  const precision = predictedSet.size === 0 ? 0 : intersection / predictedSet.size;
  const recall = truthSet.size === 0 ? 0 : intersection / truthSet.size;
  return { precision, recall };
}

test("precisionRecall helper: trivial correctness on hand-built sets", () => {
  const predicted: Ref[] = [{ file: "a", symbol: "x" }, { file: "b", symbol: "y" }];
  const truth: Ref[] = [{ file: "a", symbol: "x" }, { file: "c", symbol: "z" }];
  const { precision, recall } = precisionRecall(predicted, truth);
  assert.equal(precision, 0.5, "1 of 2 predicted is in truth");
  assert.equal(recall, 0.5, "1 of 2 truth entries was predicted");
});

test("precisionRecall helper: perfect match is 1.0/1.0", () => {
  const set: Ref[] = [{ file: "a", symbol: "x" }];
  const { precision, recall } = precisionRecall(set, set);
  assert.equal(precision, 1);
  assert.equal(recall, 1);
});

test("precisionRecall helper: empty predicted set is 0 precision (not NaN/divide-by-zero)", () => {
  const { precision, recall } = precisionRecall([], [{ file: "a", symbol: "x" }]);
  assert.equal(precision, 0);
  assert.equal(recall, 0);
});

// GROUND TRUTH (hand-verified against real Java source at
// /Users/arielyumn/Desktop/TRABAJO/nname/ms-name-restaurants/src/main/java/es/name/restaurants/
// application/service/impl/CourseApplicationServiceImpl.java, task 4a.0.3):
//
// Anchor: the WHOLE CourseApplicationServiceImpl.java file is "changed" (depth=2, confidence>=0.55).
// Every entry below is a REAL edge present in the captured impacted-outbound.json fixture AND
// independently confirmed to exist in the real source file (method body reachability):
//
//  - findByNameContainingIgnoreCase @ CourseRepositoryPort.java   (hop1 of searchCourseByFilters)
//  - findCoursesPendingDescription @ CourseRepositoryPort.java    (hop1)
//  - populateCourseDescriptionByUuid @ CourseApplicationServiceImpl.java (hop1)
//  - populateCourseDescription @ CourseApplicationServiceImpl.java (hop2, real: populateCourseDescriptionByUuid calls it)
//  - findCoursesPendingImage @ CourseRepositoryPort.java (hop1)
//  - populateCourseImage @ CourseApplicationServiceImpl.java (hop1+hop2, real)
//  - findCourseById @ CourseRepositoryPort.java (hop1 of populateCourseImage, hop2 of populateCoursesImageUseCase)
//  - generateCourseImage @ LlmImageServicePort.java (hop1/hop2)
//  - save @ CourseImageRepositoryPort.java (hop1/hop2)
//  - setImageUrl @ CourseModel.java (hop2)
//  - update @ CourseRepositoryPort.java (hop1/hop2)
//  - generateDescriptionsAndCuisineType @ CourseI18nDescriptionGenerator.java (hop2)
//  - saveCourseI18nDescriptions @ CourseRepositoryPort.java (hop1/hop2)
//  - normalize @ GenericTextNormalizer.java (hop1)
//  - normalize @ DefaultJvmSearchTextNormalizer.java (hop2)
//  - isStrongMatch @ CourseApplicationServiceImpl.java (hop1)
//  - getSearchText @ CourseSearchCandidateProjection.java (hop1/hop2)
//  - getCourseId @ CourseSearchCandidateProjection.java (hop1)
//  - findCourseById @ CourseRepositoryPort.java (hop1, from findOrCreateCourse — same symbol as above, deduped)
//  - createNewCourse @ CourseApplicationServiceImpl.java (hop1)
//  - save @ CourseRepositoryPort.java (hop1/hop2 — THE depth>=2 interface/impl-split truncation case:
//    save() is a bodyless interface method, hand-verified zero real outgoing CALLS in source, so its
//    own hop2 is correctly empty, not a false negative)
//  - createNewCourse @ CourseModel.java (hop1, from createCourse)
//  - CourseModel @ CourseModel.java (hop2, from createCourse -> createNewCourse -> CourseModel ctor)
//  - getDefaultImageUrl @ CourseModel.java (hop2)
//
// EXCLUDED from ground truth despite appearing in the raw fixture rows (R4/§4.1 confidence floor —
// correctly excluded, NOT a recall gap): three hop-2 edges in the captured fixture carry a
// sub-0.55 confidence (r2_conf), hand-verified against the raw fixture data:
//  - setImageUrl @ CourseModel.java (r2_conf=0.38, via populateCourseImage)
//  - generateDescriptionsAndCuisineType @ CourseI18nDescriptionGenerator.java (r2_conf=0.38, via populateCourseDescription)
//  - equals @ DailyMenuModel.java (r2_conf=0.28, via isStrongMatch)
// These are the CORRECT R4 floor behavior, not the adapter under-reporting — including them in the
// ground truth would have made the floor's OWN correctness look like a recall defect, which is
// exactly the kind of "trust it because it compiles" mistake §7/Scenario J exists to prevent. A
// first draft of this ground-truth set mistakenly included them (recall measured 0.6667, then 0.875
// after fixing an unrelated cross-row anchor-exclusion bug); removing these three sub-floor entries
// is the CORRECT ground truth, not floor-lowering to force green.
//
// This is the FULL set of DISTINCT (file, symbol) pairs reachable within depth=2 from the anchor at
// confidence >= 0.55 — i.e. the ground truth here is "does impactedSymbols reproduce every row the
// fixture legitimately contains ABOVE THE FLOOR", the appropriate parse/filter/anchor
// characterization for a captured-fixture test (the fixture is the captured ground truth from the
// real indexed repo; the adapter's job is to not lose or fabricate rows relative to it).
const GROUND_TRUTH: Ref[] = [
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "findByNameContainingIgnoreCase" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "findCoursesPendingDescription" },
  { file: "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java", symbol: "populateCourseDescriptionByUuid" },
  { file: "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java", symbol: "populateCourseDescription" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "findCoursesPendingImage" },
  { file: "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java", symbol: "populateCourseImage" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "findCourseById" },
  { file: "src/main/java/es/name/restaurants/application/port/ai/LlmImageServicePort.java", symbol: "generateCourseImage" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseImageRepositoryPort.java", symbol: "save" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "update" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "saveCourseI18nDescriptions" },
  { file: "src/main/java/es/name/restaurants/domain/service/text/GenericTextNormalizer.java", symbol: "normalize" },
  { file: "src/main/java/es/name/restaurants/application/service/template/normalization/DefaultJvmSearchTextNormalizer.java", symbol: "normalize" },
  { file: "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java", symbol: "isStrongMatch" },
  { file: "src/main/java/es/name/restaurants/infraestructure/adapters/persistence/entity/projection/CourseSearchCandidateProjection.java", symbol: "getSearchText" },
  { file: "src/main/java/es/name/restaurants/infraestructure/adapters/persistence/entity/projection/CourseSearchCandidateProjection.java", symbol: "getCourseId" },
  { file: "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java", symbol: "createNewCourse" },
  { file: "src/main/java/es/name/restaurants/application/port/repository/CourseRepositoryPort.java", symbol: "save" },
  { file: "src/main/java/es/name/restaurants/domain/model/course/CourseModel.java", symbol: "createNewCourse" },
  { file: "src/main/java/es/name/restaurants/domain/model/course/CourseModel.java", symbol: "CourseModel" },
  { file: "src/main/java/es/name/restaurants/domain/model/course/CourseModel.java", symbol: "getDefaultImageUrl" },
];

test("ground-truth accuracy: impactedSymbols against the REAL captured fixture reproduces the hand-verified ground truth (R13, Scenario J, §7)", async () => {
  const outbound = JSON.parse(fixture("impacted-outbound.json"));
  const emptyInbound = { columns: outbound.columns, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(outbound) : JSON.stringify(emptyInbound), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 2 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;

  const { precision, recall } = precisionRecall(result.value, GROUND_TRUTH);

  // RECORD the actual measured numbers (never assumed) — per §7/ADR-6, R13, Scenario J.
  // eslint-disable-next-line no-console
  console.log(
    `[codegraph-phase4 4a-i accuracy] n(predicted)=${result.value.length} n(truth)=${GROUND_TRUTH.length} ` +
      `precision=${precision.toFixed(4)} recall=${recall.toFixed(4)}`,
  );

  assert.equal(precision, 1, "every symbol the adapter returns for this fixture must be in the ground truth (100% behavioral precision)");
  // PROVISIONAL floor at design time was >= 0.9 (§7/ADR-6). MEASURED against this real fixture,
  // AFTER two real fixes surfaced during calibration (see the GROUND_TRUTH comment block above for
  // the full history): the adapter reproduces the ENTIRE confidence-floor-respecting ground-truth
  // set — measured recall = 1.0, n(predicted)=21, n(truth)=21. The floor below is the CONFIRMED
  // value from this real measurement, not the design-time guess.
  assert.equal(recall, 1, `measured recall ${recall} must equal the confirmed 1.0 floor (see console.log for the exact recorded number)`);
});

test("depth>=2 interface/impl-split fixture case, cross-check: 'save' entry is present but contributes no fabricated hop-2 symbol (calibration corner case, §7 step 4)", async () => {
  const outbound = JSON.parse(fixture("impacted-outbound.json"));
  const emptyInbound = { columns: outbound.columns, rows: [], total: 0 };
  let call = 0;
  const client = new FakeClient(async () => {
    call += 1;
    return { code: 0, stdout: call === 1 ? JSON.stringify(outbound) : JSON.stringify(emptyInbound), stderr: "" };
  });
  const adapter = new CodebaseMemoryCodeGraphAdapter(client);
  const changed = blast(["src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java"]);
  const result = await adapter.impactedSymbols("/repo", changed, { depth: 2 });
  assert.equal(isOk(result), true);
  if (!result.ok) return;
  const truthKeys = new Set(GROUND_TRUTH.map((r) => `${r.file}::${r.symbol}`));
  for (const s of result.value) {
    assert.ok(truthKeys.has(`${s.file}::${s.symbol}`), `unexpected/fabricated symbol not in ground truth: ${JSON.stringify(s)}`);
  }
});

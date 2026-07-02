// This is a graph-vs-lizard STATISTICAL correlation gate (rank agreement between two different
// cyclomatic engines) — semantically OPPOSITE to complexity-parity.test.ts, which is a
// byte-for-byte migration exact-match. Do not conflate (design ADR-4).
//
// D1: parity semantics = correlated-ranking, not exact-match. Two different cyclomatic engines
// (the graph's AST heuristic vs lizard's own parser) legitimately disagree on edge-case magnitude,
// so assert.deepEqual would be meaningless. Both are computed on `ccn` (the metric shared by both
// tools), over a committed REAL fixture pair, joined on the composite key (file, function). They are
// the PROMOTION gate for making the graph adapter primary — promotion requires BOTH:
//   - Spearman rank correlation rho >= 0.7  → currently MET (0.75): the tools AGREE on ranking.
//   - hotspot-set Jaccard >= 0.6            → currently NOT met (0.45): the tools DISAGREE on the set.
// Only Spearman is met, because the graph's ccn is DEFECTIVE (under-counts &&/||/?: branching,
// 0-baseline; root cause engram #1003). So the graph stays ADDITIVE-ONLY (value-add = `cognitive`,
// not ccn) and lizard remains the primary complexity extractor. The Jaccard test below is a
// characterization + regression gate — it flips to failing if an upstream ccn fix ever lifts Jaccard
// to >= 0.6, which is the signal to re-evaluate promotion. This harness is available-but-unused in
// production (default-extractors.ts is unchanged); it exists to characterize the graph, not to gate CI.
//
// `cognitive` (ADR-5) is net-new — lizard produces no cognitive metric, so it cannot be
// parity/correlation-checked against lizard. It is characterized on its own (present + numeric +
// plausibly-ranked), never joined against a lizard counterpart that does not exist.
//
// FIXTURE PROVENANCE (both REAL, same code, not fabricated):
//   - codebase-memory-complexity.json: captured `codebase-memory-mcp cli query_graph` v0.8.1
//     output (Slice 2a), Cypher `WHERE m.complexity > 1`, against the ms-name-restaurants
//     Java/Spring repo (es.name.restaurants package).
//   - lizard-restaurants-complexity.csv: REAL `python3 -m lizard --csv src` (lizard 1.23.0,
//     the pinned version) output for the SAME 10 files referenced by the graph fixture, run
//     against the same ms-name-restaurants checkout. Captured 2026-07-02 during Slice 2b apply.
//
// The graph fixture's selection threshold is `complexity > 1` (ccn >= 2) — that is the ONLY
// candidate pool available from the frozen 2a capture (it cannot be re-queried at a different
// threshold here). To keep the "hotspot set" comparison FAIR, this harness applies the SAME
// ccn >= 2 threshold to BOTH sides before computing Jaccard — it does NOT reuse production
// `parseLizardCsv`, which bakes in lizard's own opinionated CCN_THRESHOLD=5 default, and it does
// NOT compare the graph's pre-filtered 15 rows against lizard's full unfiltered universe (which
// would include ccn=1 trivial functions the graph query explicitly excluded — an asymmetric,
// unfair comparison that silently penalizes the graph for a filter lizard was never subject to).
// Symmetric ccn>=2 is the ONLY methodologically defensible choice available from this fixture
// pair; it is applied here explicitly rather than left as an implicit asymmetry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const graphFixturePath = fileURLToPath(new URL("./__fixtures__/codebase-memory-complexity.json", import.meta.url));
const lizardFixturePath = fileURLToPath(new URL("./__fixtures__/lizard-restaurants-complexity.csv", import.meta.url));

interface JoinedRow { file: string; function: string; graphCcn: number; lizardCcn: number; graphCognitive?: number }

// Raw lizard CSV row parser — deliberately NOT reusing production `parseLizardCsv` (see header
// note): this harness needs the unfiltered rows so both sides share one explicit threshold,
// applied at the join, not lizard's own CCN_THRESHOLD=5 default baked into the production parser.
function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}
function splitCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      if (close === -1) return null;
      fields.push(line.slice(i, close + 1));
      i = close + 1;
      if (i < line.length && line[i] === ",") i++;
    } else {
      const comma = line.indexOf(",", i);
      if (comma === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, comma));
      i = comma + 1;
    }
  }
  return fields.length >= 11 ? fields : null;
}
function parseRawLizardCsv(csv: string): Array<{ file: string; function: string; ccn: number }> {
  const rows: Array<{ file: string; function: string; ccn: number }> = [];
  for (const raw of csv.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (!fields) continue;
    const ccn = Number(stripQuotes(fields[1]!));
    const file = stripQuotes(fields[6]!);
    const rawFnName = stripQuotes(fields[7]!);
    // lizard emits "Class::method" for Java; the graph's m.name is the bare method name — strip
    // the class-qualifier so the join key aligns across both tools.
    const fnName = rawFnName.includes("::") ? rawFnName.split("::").slice(1).join("::") : rawFnName;
    if (!Number.isFinite(ccn)) continue;
    rows.push({ file, function: fnName, ccn });
  }
  return rows;
}

function parseGraphFixture(): Array<{ file: string; function: string; ccn: number; cognitive: number | undefined }> {
  const parsed = JSON.parse(readFileSync(graphFixturePath, "utf8")) as { columns: string[]; rows: string[][] };
  const iName = parsed.columns.indexOf("m.name");
  const iFile = parsed.columns.indexOf("m.file_path");
  const iCcn = parsed.columns.indexOf("m.complexity");
  const iCognitive = parsed.columns.indexOf("m.cognitive");
  return parsed.rows.map((row) => ({
    file: row[iFile]!,
    function: row[iName]!,
    ccn: Number(row[iCcn]),
    cognitive: iCognitive >= 0 ? Number(row[iCognitive]) : undefined,
  }));
}

function joinByFileFunction(): JoinedRow[] {
  const graphRows = parseGraphFixture();
  const lizardRows = parseRawLizardCsv(readFileSync(lizardFixturePath, "utf8"));
  const lizardByKey = new Map(lizardRows.map((r) => [`${r.file}::${r.function}`, r]));

  const joined: JoinedRow[] = [];
  for (const g of graphRows) {
    const key = `${g.file}::${g.function}`;
    const l = lizardByKey.get(key);
    if (!l) continue; // no lizard counterpart at this composite key — excluded from the joined set
    joined.push({ file: g.file, function: g.function, graphCcn: g.ccn, lizardCcn: l.ccn, graphCognitive: g.cognitive });
  }
  return joined;
}

// Hotspot-set Jaccard: intersection over union of (file, function) identities each tool flags,
// where "flagged" is evaluated at the SAME shared ccn threshold applied to both sides by the
// caller (see the symmetric-threshold filtering in the Jaccard test below).
function jaccard(graphKeys: Set<string>, lizardKeys: Set<string>): number {
  const intersectionSize = [...graphKeys].filter((k) => lizardKeys.has(k)).length;
  const unionSize = new Set([...graphKeys, ...lizardKeys]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// Spearman rank correlation with average-rank tie handling, over the joined ccn pairs.
function spearman(a: number[], b: number[]): number {
  const rank = (values: number[]): number[] => {
    const order = values.map((_, i) => i).sort((x, y) => values[x]! - values[y]!);
    const ranks = new Array<number>(values.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k]!] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const meanA = ra.reduce((s, v) => s + v, 0) / n;
  const meanB = rb.reduce((s, v) => s + v, 0) / n;
  const cov = ra.reduce((s, v, i) => s + (v - meanA) * (rb[i]! - meanB), 0);
  const sdA = Math.sqrt(ra.reduce((s, v) => s + (v - meanA) ** 2, 0));
  const sdB = Math.sqrt(rb.reduce((s, v) => s + (v - meanB) ** 2, 0));
  if (sdA === 0 || sdB === 0) throw new Error("Spearman is undefined when one side has zero variance");
  return cov / (sdA * sdB);
}

test("the fixture pair's joined intersection has n >= 3 — Spearman is undefined at n<2 and uninformative at n=2 (§9 guard)", () => {
  const joined = joinByFileFunction();
  assert.ok(joined.length >= 3, `fixture-construction failure: joined intersection n=${joined.length}, need >= 3`);
});

test("promotion-readiness characterization: graph-vs-lizard ccn hotspot-set Jaccard is BELOW the 0.6 promotion gate — the graph's ccn is defective, so it stays additive-only (NOT a viable ccn-parity replacement)", () => {
  const HOTSPOT_THRESHOLD = 2; // matches the graph fixture's own Cypher WHERE m.complexity > 1
  const graphRows = parseGraphFixture().filter((r) => r.ccn >= HOTSPOT_THRESHOLD);
  const lizardRows = parseRawLizardCsv(readFileSync(lizardFixturePath, "utf8")).filter((r) => r.ccn >= HOTSPOT_THRESHOLD);
  const graphKeys = new Set(graphRows.map((r) => `${r.file}::${r.function}`));
  const lizardKeys = new Set(lizardRows.map((r) => `${r.file}::${r.function}`));
  const value = jaccard(graphKeys, lizardKeys);
  // CHARACTERIZATION + PROMOTION REGRESSION GATE (root-caused 2026-07-02, engram #1003; NOT tuned).
  // The real symmetric-threshold Jaccard on this REAL fixture pair is 0.4545 (15/33), BELOW the 0.6
  // promotion gate. This is NOT a methodology artifact — scope, join-key, and threshold were all
  // ruled out by re-querying the live graph (the number does not move). Root cause: the
  // codebase-memory graph's cyclomatic complexity is DEFECTIVE — it does not count boolean operators
  // (&&/||) or ternaries (?:) and uses a 0-baseline, rating 454/506 methods as ccn=0 (max ccn
  // repo-wide = 5 vs lizard's 6-7). So 19 of lizard's 34 ccn>=2 hotspots fall below the graph's line
  // and vanish from its set (while the intersection's RANK order still agrees — see the Spearman
  // test). The graph is therefore NOT a viable ccn-parity replacement and MUST stay ADDITIVE-ONLY
  // (its value-add is `cognitive`, not ccn); lizard remains the primary complexity extractor.
  //
  // This asserts the CURRENT non-viability and doubles as a regression gate: if a future upstream fix
  // to the codebase-memory indexer's complexity algorithm lifts this to >= 0.6, THIS TEST WILL FAIL —
  // and that failure is the SIGNAL to re-evaluate promoting CodebaseMemoryGraphAdapter to primary for
  // ccn (re-run against a fresh fixture pair and, per R7, add an absolute-ccn spot-check first).
  assert.ok(
    value < 0.6,
    `graph-vs-lizard ccn Jaccard rose to ${value} (>= 0.6): the graph's ccn may now be viable — ` +
      "re-evaluate promoting the graph adapter to primary for ccn (see engram #1003).",
  );
});

test("Spearman rank correlation on ccn (joined by file+function) >= 0.7 between the graph fixture and the real lizard CSV", () => {
  const joined = joinByFileFunction();
  assert.ok(joined.length >= 3, "n>=3 guard must hold before computing Spearman");
  const value = spearman(joined.map((r) => r.graphCcn), joined.map((r) => r.lizardCcn));
  assert.ok(value >= 0.7, `real Spearman rho = ${value}, gate requires >= 0.7`);
});

test("cognitive sanity check: present + numeric on the graph fixture's hotspot rows (ADR-5 value-add, characterized alone — not a lizard parity check)", () => {
  const graphRows = parseGraphFixture();
  assert.ok(graphRows.length > 0, "fixture must carry at least one row to characterize");
  for (const row of graphRows) {
    assert.equal(typeof row.cognitive, "number", `cognitive must be numeric for ${row.file}::${row.function}`);
    assert.ok(Number.isFinite(row.cognitive), `cognitive must be finite for ${row.file}::${row.function}`);
  }
});

test("cognitive sanity check: plausibly-ranked — monotonic-ish with ccn is not required, but a valid finite Spearman self-correlation must be computable", () => {
  const graphRows = parseGraphFixture();
  const ccns = graphRows.map((r) => r.ccn);
  const cognitives = graphRows.map((r) => r.cognitive!);
  // Self-consistency: cognitive must not be a degenerate constant series (which would make any
  // "plausibly ranked" claim vacuous) — it must carry real variance across the fixture's rows.
  const distinctCognitiveValues = new Set(cognitives).size;
  assert.ok(distinctCognitiveValues > 1, "cognitive must carry real variance across the fixture, not a degenerate constant");
  const rho = spearman(ccns, cognitives);
  assert.ok(Number.isFinite(rho), "a valid finite rank correlation must be computable between ccn and cognitive on the graph fixture alone");
});

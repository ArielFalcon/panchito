// qa-engine/src/shared-infrastructure/code-graph/codebase-memory-code-graph.adapter.ts
//
// CodebaseMemoryCodeGraphAdapter implements CodeGraphPort against the codebase-memory knowledge
// graph via `query_graph` + LITERAL Cypher — the REAL structural implementation for Phase 4 (design
// §2, §3, §4; ADR-1, ADR-5). Distinct basename/class from the existing
// change-analysis/infrastructure/extractors/codebase-memory-graph.adapter.ts (which implements a
// DIFFERENT port, ComplexityExtractorPort) — see ADR-1. Placement: shared-infrastructure/ because
// this port has no single owning bounded context (phases 3/4 both spawn the same binary, precedent
// #947).
//
// SLICE SCOPE:
//   - REAL (4a-i): impactedSymbols, the safe literal-inlining helpers (inlineList/inlineLiteral),
//     shared row parsing (parseRows), the confidence floor.
//   - REAL (4a-i, per design §6/R11): syncTo — spawns index_repository, maps a whole-index failure to
//     IndexFailed. Implemented+tested here; NEVER called by RunQaUseCase in this change (ADR-4).
//   - REAL (4a-ii, this batch): coChangeCoupling (undirected FILE_CHANGES_WITH mapping, §3.2),
//     callersOf (inbound CALLS anchored on the symbol, §3.3).
//   - INERT ok([]) stubs, OUT OF SCOPE FOR THIS ENTIRE CHANGE: existingCoverage, structurallyRelated
//     (spec §2 non-requirements, Scenario K — never promoted to real graph data by this change).
//
// GROUNDING DEVIATION FROM DESIGN §3.1 LITERAL QUERY TEXT (discovered during 4a fixture-capture
// against the real codebase-memory-mcp v0.8.1 binary): a `WHERE` clause placed immediately after an
// `OPTIONAL MATCH` clause causes the CLI to silently fall back to a degenerate default projection
// (columns become a.name/a.qualified_name/a.label only) instead of executing the intended filter or
// erroring loudly. Verified reproducible with a minimal isolated probe. WORKAROUND (permitted by the
// design's own client-side-filter fallback clause in §3.0/§3.1: "where a hop can't express it, filter
// CLIENT-SIDE in parse()"): the confidence floor on any OPTIONAL MATCH hop is NOT expressed in a
// trailing Cypher WHERE — the confidence column is returned as a plain RETURN value and filtered
// client-side in parse(). The floor on the FIRST (non-optional) hop, attached to the anchor MATCH's
// own WHERE, executes correctly and is used as written.
//
// GROUNDING DEVIATIONS FROM DESIGN §3.2/§11 (confirmed empirically against the real binary, 4a-ii):
//   - File node property is `file_path`, NOT `path` — design §3.2's literal query text (`f.path`/
//     `g.path`) is a grounding mismatch. `coChangeCoupling` uses `f.file_path`/`g.file_path`.
//   - FILE_CHANGES_WITH is stored DIRECTED, exactly one row per pair (not two directed rows). A
//     directed-only match anchored on the "changed" side alone would silently drop any pair where the
//     changed file is stored as the edge's TARGET — the match MUST be UNDIRECTED
//     `(f)-[r:FILE_CHANGES_WITH]-(g)`, deduped by the coupled (non-anchor) file.
//
// Confirmed response shape (2a's captured fixture pattern, mirrored here): row-oriented, all-string
// cells — `{ columns: string[], rows: string[][], total: number }`.
import { ok, err, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius } from "../../shared-kernel/blast-radius.ts";
import type { CodeGraphPort } from "../../shared-kernel/ports/code-graph.port.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "../../shared-kernel/code/index.ts";

// Minimal shape this adapter depends on — CodebaseMemoryClient satisfies it structurally, so tests
// can inject a fake without importing the shared-infrastructure client (verbatim seam reused from
// the sibling change-analysis extractor's CodebaseMemoryCliClient, per design §2).
export interface CodebaseMemoryCliClient {
  cli(tool: string, jsonArg: string, repoDir: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const DEFAULT_MIN_CONFIDENCE = 0.55;

// hopVars supports depth 1..3 (design §3.1: the advisory use-case is depth=3). An out-of-range
// opts.depth would otherwise index past hopVars and splice the literal string "undefined" into
// the live Cypher — clamp defensively at the single entry point (impactedSymbols).
const MAX_HOP_DEPTH = 3;

// ---------------------------------------------------------------------------------------------
// §3.0 — SAFE literal inlining. Net-new: the sibling adapter inlines a CONSTANT query, this one
// inlines UNTRUSTED-SHAPED dynamic values (changed file paths, symbol names) into a literal Cypher
// string. Any value containing a control character or newline is DROPPED (never injected, never
// escaped-and-kept) — a per-value degrade, never a query-corruption risk.
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_OR_NEWLINE = /[\x00-\x1f\x7f]/;

/** Escapes a single value for a Cypher string literal: `\` -> `\\` then `'` -> `\'`, wraps in single
 *  quotes. Returns null (dropped) for a value containing a control char/newline — never injected. */
export function inlineLiteral(value: string): string | null {
  if (CONTROL_CHAR_OR_NEWLINE.test(value)) return null;
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Escapes and joins a list of values into a Cypher list literal (`['a.java','b\\'c.java']`).
 *  Dropped (control-char/newline) values are excluded from the list. Returns null when the input is
 *  empty or every value was dropped — the caller uses this to short-circuit without issuing a query. */
export function inlineList(values: string[]): string | null {
  const escaped = values.map(inlineLiteral).filter((v): v is string => v !== null);
  if (escaped.length === 0) return null;
  return `[${escaped.join(",")}]`;
}

// ---------------------------------------------------------------------------------------------
// §3.4 — parsing (one shape only: query_graph's {columns, rows, total}).
// ---------------------------------------------------------------------------------------------

interface GraphQueryResponse {
  columns: string[];
  rows: string[][];
  total: number;
}

function isGraphQueryResponse(value: unknown): value is GraphQueryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as GraphQueryResponse).columns) &&
    Array.isArray((value as GraphQueryResponse).rows)
  );
}

function parseRows(stdout: string): Result<GraphQueryResponse, CodeGraphUnavailable> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (e) {
    return err({ reason: e instanceof Error ? e.message : String(e) });
  }
  if (!isGraphQueryResponse(payload)) {
    return err({ reason: "codebase-memory query_graph response missing columns/rows" });
  }
  return ok(payload);
}

// Guarded string->number coercion — an absent/non-numeric cell yields undefined, never NaN.
function toNumber(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === "") return undefined;
  const n = Number(cell);
  return Number.isFinite(n) ? n : undefined;
}

function refKey(ref: LocalSymbolRef): string {
  return `${ref.file}::${ref.symbol}`;
}

// ---------------------------------------------------------------------------------------------
// impactedSymbols — §3.1, §4.1, §4.2. Two literal queries (outbound callees + inbound callers),
// each anchored by `WHERE a.file_path IN <inlined changed files>`, hops unrolled to opts.depth,
// confidence floor primarily in the first-hop WHERE + defensive client-side re-check for every hop.
// ---------------------------------------------------------------------------------------------

function buildHopQuery(direction: "outbound" | "inbound", filesLiteral: string, minConfidence: number, depth: number): string {
  const arrow = direction === "outbound" ? { left: "-", right: "->" } : { left: "<-", right: "-" };
  const anchorClause = `MATCH (a:Method)${arrow.left}[r1:CALLS]${arrow.right}(b:Method)\nWHERE a.file_path IN ${filesLiteral} AND r1.confidence >= ${minConfidence}`;

  const hopVars = ["a", "b", "c", "d"]; // supports depth up to 3 (a=anchor, b/c/d = hops 1/2/3)
  const returnCols: string[] = ["a.file_path AS a_file", "a.name AS a_name"];
  let query = anchorClause;

  for (let hop = 2; hop <= depth; hop++) {
    const fromVar = hopVars[hop - 1]!; // hop=2 -> "b", hop=3 -> "c"
    const toVar = hopVars[hop]!; // hop=2 -> "c", hop=3 -> "d"
    query += `\nOPTIONAL MATCH (${fromVar})${arrow.left}[r${hop}:CALLS]${arrow.right}(${toVar}:Method)`;
  }

  for (let hop = 1; hop <= depth; hop++) {
    const nodeVar = hopVars[hop]!; // hop=1 -> "b", hop=2 -> "c", hop=3 -> "d"
    returnCols.push(`${nodeVar}.name AS ${nodeVar}_name`, `${nodeVar}.file_path AS ${nodeVar}_file`, `r${hop}.confidence AS r${hop}_conf`);
  }

  query += `\nRETURN ${returnCols.join(", ")}\nLIMIT 200`;
  return query;
}

// Excludes a hop result from the impacted set only when it is IDENTICAL to the row's OWN anchor
// node (a_file/a_name) — i.e. the literal start-of-traversal method, which a self-referential
// CALLS edge (a method calling itself, or a query artifact) could otherwise surface as its own
// "impacted symbol". This is intentionally PER-ROW, not a global cross-row exclusion: when the
// changed set is a whole file, many DIFFERENT methods in that file are each their own anchor in
// different rows, and a hop landing on one of those OTHER anchor methods (a real same-file callee)
// is a legitimate impacted symbol, not the traversal's own start node. A global exclude-by-name set
// would incorrectly drop every same-file callee that happens to share a name with some other row's
// anchor — this caused a measured false-negative regression during ground-truth calibration (recall
// dropped from ~1.0 to 0.67 against the real fixture) and was corrected to per-row scope.
function mapHopRows(response: GraphQueryResponse, depth: number, minConfidence: number): LocalSymbolRef[] {
  const idx = (name: string) => response.columns.indexOf(name);
  const hopVars = ["a", "b", "c", "d"];
  const results: LocalSymbolRef[] = [];
  const seen = new Set<string>();

  const iAFile = idx("a_file");
  const iAName = idx("a_name");

  for (const row of response.rows) {
    const anchorFile = iAFile >= 0 ? row[iAFile] : undefined;
    const anchorName = iAName >= 0 ? row[iAName] : undefined;
    const rowAnchorKey =
      anchorFile !== undefined && anchorName !== undefined ? refKey({ file: anchorFile, symbol: anchorName }) : undefined;

    for (let hop = 1; hop <= depth; hop++) {
      const nodeVar = hopVars[hop]!;
      const iName = idx(`${nodeVar}_name`);
      const iFile = idx(`${nodeVar}_file`);
      const iConf = idx(`r${hop}_conf`);

      const name = iName >= 0 ? row[iName] : undefined;
      const file = iFile >= 0 ? row[iFile] : undefined;
      if (name === undefined || file === undefined || name === "" || file === "") continue; // empty hop cell (OPTIONAL MATCH miss) — not a symbol

      const conf = toNumber(iConf >= 0 ? row[iConf] : undefined);
      // Hop 1's floor is already enforced by the query's own WHERE; re-check defensively here too.
      // Hops >= 2 have NO Cypher-side floor (the OPTIONAL MATCH WHERE workaround, see file header) —
      // this client-side check is the ONLY enforcement point for those hops.
      if (conf === undefined || conf < minConfidence) continue;

      const ref: LocalSymbolRef = { file, symbol: name };
      const key = refKey(ref);
      if (key === rowAnchorKey) continue; // this row's own traversal start node — never its own impact
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(ref);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------------------------
// coChangeCoupling — §3.2. One literal query, UNDIRECTED FILE_CHANGES_WITH match anchored by
// `WHERE f.file_path IN <inlined files>`, mapped to CoupledFile[] deduped by the coupled
// (non-anchor) file.
// ---------------------------------------------------------------------------------------------

function buildCoChangeQuery(filesLiteral: string): string {
  return (
    `MATCH (f:File)-[r:FILE_CHANGES_WITH]-(g:File)\nWHERE f.file_path IN ${filesLiteral}\n` +
    `RETURN f.file_path AS f_path, g.file_path AS g_path, r.coupling_score AS coupling_score, ` +
    `r.co_changes AS co_changes, r.last_co_change AS last_co_change\nORDER BY r.coupling_score DESC\nLIMIT 200`
  );
}

// anchorFiles is accepted for documentation/future-proofing (the WHERE clause already guarantees
// f_path is always one of the queried files) but is not needed to pick the coupled endpoint: the
// query's own anchor (`WHERE f.file_path IN <files>`) always binds `f` to the matched file, so the
// coupled (non-anchor) file is always g_path, regardless of which side the underlying storage uses.
function mapCoChangeRows(response: GraphQueryResponse, _anchorFiles: ReadonlySet<string>): CoupledFile[] {
  const iFPath = response.columns.indexOf("f_path");
  const iGPath = response.columns.indexOf("g_path");
  const iScore = response.columns.indexOf("coupling_score");
  const iCoChanges = response.columns.indexOf("co_changes");
  const iLastCoChange = response.columns.indexOf("last_co_change");

  const results: CoupledFile[] = [];
  const seen = new Set<string>();

  for (const row of response.rows) {
    const fPath = iFPath >= 0 ? row[iFPath] : undefined;
    const gPath = iGPath >= 0 ? row[iGPath] : undefined;
    if (fPath === undefined || gPath === undefined || fPath === "" || gPath === "") continue;
    if (gPath === fPath) continue; // a self-loop row would otherwise surface the anchor as its own coupling

    const couplingScore = toNumber(iScore >= 0 ? row[iScore] : undefined);
    const coChanges = toNumber(iCoChanges >= 0 ? row[iCoChanges] : undefined);
    if (couplingScore === undefined || coChanges === undefined) continue; // missing numeric cell — drop row

    const lastCoChange = iLastCoChange >= 0 ? row[iLastCoChange] : undefined;

    if (seen.has(gPath)) continue;
    seen.add(gPath);

    results.push({
      file: gPath,
      couplingScore,
      coChanges,
      ...(lastCoChange !== undefined && lastCoChange !== "" ? { lastCoChange } : {}),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------------------------
// callersOf — §3.3. Inbound CALLS anchored on the symbol (file_path + name via inlineLiteral),
// explicit unrolled hops to the positional depth (clamped 1..3), confidence floor primarily in the
// anchor's own WHERE (hop 1) + client-side re-check for every hop (mirrors impactedSymbols).
// ---------------------------------------------------------------------------------------------

function buildCallersQuery(fileLiteral: string, nameLiteral: string, minConfidence: number, depth: number): string {
  const anchorClause = `MATCH (a:Method)<-[r1:CALLS]-(b:Method)\nWHERE a.file_path IN ${fileLiteral} AND a.name = ${nameLiteral} AND r1.confidence >= ${minConfidence}`;

  const hopVars = ["a", "b", "c", "d"]; // supports depth up to 3
  const returnCols: string[] = ["a.file_path AS a_file", "a.name AS a_name"];
  let query = anchorClause;

  for (let hop = 2; hop <= depth; hop++) {
    const fromVar = hopVars[hop - 1]!;
    const toVar = hopVars[hop]!;
    query += `\nOPTIONAL MATCH (${fromVar})<-[r${hop}:CALLS]-(${toVar}:Method)`;
  }

  for (let hop = 1; hop <= depth; hop++) {
    const nodeVar = hopVars[hop]!;
    returnCols.push(`${nodeVar}.name AS ${nodeVar}_name`, `${nodeVar}.file_path AS ${nodeVar}_file`, `r${hop}.confidence AS r${hop}_conf`);
  }

  query += `\nRETURN ${returnCols.join(", ")}\nLIMIT 200`;
  return query;
}

function mapCallerRows(response: GraphQueryResponse, anchor: LocalSymbolRef, depth: number, minConfidence: number): LocalSymbolRef[] {
  const idx = (name: string) => response.columns.indexOf(name);
  const hopVars = ["a", "b", "c", "d"];
  const anchorKey = refKey(anchor);
  const results: LocalSymbolRef[] = [];
  const seen = new Set<string>();

  for (const row of response.rows) {
    for (let hop = 1; hop <= depth; hop++) {
      const nodeVar = hopVars[hop]!;
      const iName = idx(`${nodeVar}_name`);
      const iFile = idx(`${nodeVar}_file`);
      const iConf = idx(`r${hop}_conf`);

      const name = iName >= 0 ? row[iName] : undefined;
      const file = iFile >= 0 ? row[iFile] : undefined;
      if (name === undefined || file === undefined || name === "" || file === "") continue;

      const conf = toNumber(iConf >= 0 ? row[iConf] : undefined);
      if (conf === undefined || conf < minConfidence) continue;

      const ref: LocalSymbolRef = { file, symbol: name };
      const key = refKey(ref);
      if (key === anchorKey) continue; // never surface the anchor as its own caller (e.g. a hop loop-back)
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(ref);
    }
  }

  return results;
}

export class CodebaseMemoryCodeGraphAdapter implements CodeGraphPort {
  constructor(
    private readonly client: CodebaseMemoryCliClient,
    private readonly project = "",
  ) {}

  async impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    if (changed.isEmpty) return ok([]);

    const filesLiteral = inlineList([...changed.changedFiles]);
    if (filesLiteral === null) return ok([]); // every changed file was rejected by the inliner — nothing safe to query

    const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    // Clamp once here — the clamped value flows to BOTH buildHopQuery (query construction) and
    // mapHopRows (row mapping), so the two can never disagree on the hop count.
    const depth = Math.min(Math.max(1, Math.trunc(opts.depth)), MAX_HOP_DEPTH);

    const outboundResult = await this.runHopQuery(repoDir, "outbound", filesLiteral, minConfidence, depth);
    if (!outboundResult.ok) return outboundResult;

    const inboundResult = await this.runHopQuery(repoDir, "inbound", filesLiteral, minConfidence, depth);
    if (!inboundResult.ok) return inboundResult;

    const seen = new Set<string>();
    const union: LocalSymbolRef[] = [];
    for (const ref of [...outboundResult.value, ...inboundResult.value]) {
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(ref);
    }
    return ok(union);
  }

  private async runHopQuery(
    repoDir: string,
    direction: "outbound" | "inbound",
    filesLiteral: string,
    minConfidence: number,
    depth: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const query = buildHopQuery(direction, filesLiteral, minConfidence, depth);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapHopRows(parsed.value, depth, minConfidence));
  }

  /** Real per design §3.2 (corrected grounding, apply-progress): UNDIRECTED FILE_CHANGES_WITH match
   *  anchored by `WHERE f.file_path IN <inlined files>`, mapped to CoupledFile[] deduped by the
   *  coupled (non-anchor) file. No confidence floor — co-change is a git fact, not a CALLS edge. */
  async coChangeCoupling(
    repoDir: string,
    files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>> {
    if (files.length === 0) return ok([]);

    const filesLiteral = inlineList(files);
    if (filesLiteral === null) return ok([]); // every file was rejected by the inliner

    const query = buildCoChangeQuery(filesLiteral);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapCoChangeRows(parsed.value, new Set(files)));
  }

  /** Real per design §3.3: inbound CALLS anchored on `symbol.file` + `symbol.symbol` (both via
   *  inlineLiteral), explicit unrolled hops to the clamped positional depth, confidence floor
   *  primarily in the anchor's own WHERE + client-side re-check for every hop. */
  async callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,
    opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const fileLiteral = inlineList([symbol.file]);
    const nameLiteral = inlineLiteral(symbol.symbol);
    if (fileLiteral === null || nameLiteral === null) return ok([]); // symbol cannot be safely inlined

    const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const clampedDepth = Math.min(Math.max(1, Math.trunc(depth)), MAX_HOP_DEPTH);

    const query = buildCallersQuery(fileLiteral, nameLiteral, minConfidence, clampedDepth);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapCallerRows(parsed.value, symbol, clampedDepth, minConfidence));
  }

  /** OUT OF SCOPE for this entire change (spec §2 non-requirements, Scenario K): the spike proved
   *  zero TESTS/TESTS_FILE/COVERS edges exist. Stays inert — never promoted to real graph data. */
  async existingCoverage(
    _repoDir: string,
    _changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** OUT OF SCOPE for this entire change (spec §2 non-requirements, Scenario K). */
  async structurallyRelated(
    _repoDir: string,
    _symbols: LocalSymbolRef[],
    _minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Real per design §6/R11: spawns index_repository, maps a whole-index failure to IndexFailed.
   *  NEVER called by RunQaUseCase in this change (ADR-4) — implemented+tested so the capability
   *  exists, exercised only by this adapter's own unit tests until a future phase wires it live. */
  async syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>> {
    const jsonArg = JSON.stringify({
      project: this.project,
      repo_path: repoDir,
      changed_files: changedFiles,
      semantic: opts?.semantic ?? false,
    });
    const res = await this.client.cli("index_repository", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory index_repository unavailable" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(res.stdout);
    } catch (e) {
      return err({ reason: e instanceof Error ? e.message : String(e) });
    }
    const nodeCount = toNumber(
      typeof payload === "object" && payload !== null && "node_count" in payload
        ? String((payload as { node_count: unknown }).node_count)
        : undefined,
    );
    if (nodeCount === undefined) {
      return err({ reason: "codebase-memory index_repository response missing node_count" });
    }
    return ok({ nodeCount });
  }
}

// qa-engine/src/contexts/change-analysis/infrastructure/extractors/codebase-memory-graph.adapter.ts
//
// CodebaseMemoryGraphAdapter implements ComplexityExtractorPort against the codebase-memory
// knowledge graph via `query_graph`+Cypher — a SECOND complexity source behind the existing port,
// beside LizardComplexityAdapter (design §6.2). Context-local by ADR-2 (the ADAPTER stays here,
// matching lizard-complexity.adapter.ts); only the raw spawn client lives in
// shared-infrastructure/code-graph/ (ADR-1). NOT wired into default-extractors.ts (§7) — this
// adapter is exercised only by the correlation harness until a future primary-promotion.
//
// Confirmed response shape (2a's captured fixture, design §6.1): row-oriented, all-string cells —
// `{ columns: string[], rows: string[][], total: number }` — NOT a `{nodes:[...]}` node array.
// Columns are resolved by NAME (never fixed position), since a Cypher RETURN order is not an API
// contract worth hardcoding against.
//
// Three-outcome degrade (never conflates "graph unreachable" with "graph says no hotspots"):
//   - ExtractorSkipped: client degrade (code===null), JSON parse failure, or a non-{columns,rows}
//     payload — a whole-extraction failure.
//   - legitimate ok([]): the graph responded successfully but zero rows, or every row was excluded
//     by file-path filtering or per-row coercion — a valid "no signal", not an error.
//   - ok(hotspots): the normal populated case.
import { ok, err, type Result } from "@kernel/result.ts";
import type { ComplexityExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ComplexityHotspot } from "../../domain/static-signal.ts";

// Minimal shape this adapter depends on — CodebaseMemoryClient satisfies it structurally, so tests
// can inject a fake without importing the shared-infrastructure client.
export interface CodebaseMemoryCliClient {
  cli(tool: string, jsonArg: string, repoDir: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const TOOL = "query_graph";

// The confirmed CLI response shape (2a fixture ground truth): row-oriented, all-string cells.
interface GraphQueryResponse { columns: string[]; rows: string[][]; total: number }

function isGraphQueryResponse(value: unknown): value is GraphQueryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as GraphQueryResponse).columns) &&
    Array.isArray((value as GraphQueryResponse).rows)
  );
}

// Guarded string->number coercion — an absent/non-numeric cell yields undefined, never NaN.
function toNumber(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const n = Number(cell);
  return Number.isFinite(n) ? n : undefined;
}

export class CodebaseMemoryGraphAdapter implements ComplexityExtractorPort {
  constructor(private readonly client: CodebaseMemoryCliClient) {}

  async extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>> {
    // Early-return on an empty changed-set (unlike the sibling extractors, which don't early-return):
    // a graph CLI spawn always incurs a full process-launch cost, so short-circuit before spawning.
    if (ctx.changedFiles.length === 0) return ok([]);

    const cypherJson = this.buildCypherArg();
    const res = await this.client.cli(TOOL, cypherJson, ctx.repoDir);
    if (res.code === null) {
      return err({ extractor: "complexity", reason: res.stderr || "codebase-memory unavailable" });
    }
    return this.parse(res.stdout, ctx.changedFiles);
  }

  private parse(stdout: string, changedFiles: string[]): Result<ComplexityHotspot[], ExtractorSkipped> {
    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch (e) {
      return err({ extractor: "complexity", reason: e instanceof Error ? e.message : String(e) });
    }
    if (!isGraphQueryResponse(payload)) {
      return err({ extractor: "complexity", reason: "codebase-memory query_graph response missing columns/rows" });
    }

    const idx = (name: string) => payload.columns.indexOf(name);
    const iName = idx("m.name");
    const iFile = idx("m.file_path");
    const iComplexity = idx("m.complexity");
    const iCognitive = idx("m.cognitive");
    const iStartLine = idx("m.start_line");
    const iLines = idx("m.lines");

    const changedSet = new Set(changedFiles);
    const hotspots: ComplexityHotspot[] = [];

    for (const row of payload.rows) {
      const file = iFile >= 0 ? row[iFile] : undefined;
      if (file === undefined || !changedSet.has(file)) continue; // not in the changed set — skip

      const fn = iName >= 0 ? row[iName] : undefined;
      const ccn = toNumber(iComplexity >= 0 ? row[iComplexity] : undefined);
      const line = toNumber(iStartLine >= 0 ? row[iStartLine] : undefined);
      const nloc = toNumber(iLines >= 0 ? row[iLines] : undefined);
      const cognitive = toNumber(iCognitive >= 0 ? row[iCognitive] : undefined);

      // Per-row degrade: a row missing any required numeric field is DROPPED, not fabricated as
      // NaN/0, and does not fail the whole extraction (design §8 R6(b)).
      if (fn === undefined || ccn === undefined || line === undefined || nloc === undefined) continue;

      const hotspot: ComplexityHotspot = { file, function: fn, ccn, nloc, line };
      if (cognitive !== undefined) hotspot.cognitive = cognitive; // ADR-5: populate only when present
      hotspots.push(hotspot);
    }

    return ok(hotspots); // empty here is a legitimate "no signal", not a failure
  }

  // Cypher for per-Method complexity, requesting every field the mapping needs. Filtering to
  // ctx.changedFiles is applied client-side in parse() (§6.2) rather than baked into the Cypher
  // WHERE, keeping the query itself stable and independent of the changed-set shape/size.
  private buildCypherArg(): string {
    const query =
      "MATCH (m:Method) WHERE m.complexity > 1 RETURN m.name, m.file_path, m.complexity, " +
      "m.cognitive, m.start_line, m.end_line, m.lines ORDER BY m.complexity DESC LIMIT 200";
    return JSON.stringify({ query });
  }
}

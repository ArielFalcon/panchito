// Slice G — Context Pack (P8, P9, P10 precursor, P11 precursor).
//
// The orchestrator builds a deterministic, per-objective Context Pack BEFORE the first
// generation write and pushes it into the VOLATILE band of the generator prompt. The pack
// is the "RAG we lack without a vector store" — but implemented as a deterministic PUSH
// from the orchestrator, not an on-demand agent-pull (no new MCP tool; survives compaction).
//
// Components per pack:
//   (a) Blast-radius (code) — the ExplorationBrief produced by the qa-explorer agent pass
//       (runs Serena, returns BlastNode[] + FeBe + contracts). The orchestrator reuses the
//       existing maybeExplore machinery; this module ASSEMBLES the pack from the brief, it
//       does NOT call Serena directly (Serena is an agent-side MCP, invisible from src/).
//   (b) DOM slice — captured by captureDomForRoutes (Playwright; orchestrator-side) from
//       the routes listed in the brief. Budget-sized via capDomLines, not a fixed 4×60 cap.
//   (c) Contracts — relevant OpenAPI operations from the ArchitectureContext (context.json)
//       filtered to the routes/operations the brief identified.
//
// The pack is rendered as a single text block and injected as a VOLATILE "context-pack"
// section in buildPromptAssembled (prompts.ts). When the pack is absent (capture failed,
// no brief, no routes), the generator falls back to its own exploration — the existing
// behaviour is preserved and the explore-first mandate stays active.
//
// PR-aware union: callers may supply a list of PR-level changed files (the union across
// the full commit range, computed by getChangedFilesInRange) to filter the contracts
// section. When absent, the brief's own symbols are used for filtering.
//
// Design constraints:
//   - Project-agnostic: no portfolio/petclinic specifics.
//   - LLM read-only on watched repos: the pack is built entirely from orchestrator-side
//     data (DOM via Playwright, brief via agent read-only pass, contracts from context.json).
//   - DI-testable: ContextPackDeps is injectable, defaultContextPackDeps wires the real
//     captureDomForRoutes and log.
//   - Degrades safely: every component is best-effort; a failed component yields an absent
//     section, never a crashed run.
//   - complete/exhaustive unaffected: the pack is wired only on the FIRST-pass generation
//     call in diff/manual modes (where a brief and a specific objective exist).

import { sanitizeText } from "../orchestrator/sanitizer";
import { capDomLines } from "./dom-snapshot";
import type { ExplorationBrief, BlastNode, ContractFact, FeBeFact } from "./exploration-brief";
import type { ArchitectureContext, ApiOperation } from "./context";
import type { CaptureDomDeps } from "./dom-snapshot";
import { captureDomForRoutes } from "./dom-snapshot";
import type { ChangedElement } from "./changed-elements";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContextPackInput {
  // The ExplorationBrief from the qa-explorer pass (blast-radius via Serena). When
  // absent (explorer disabled, brief unparseable, empty blast-radius), only DOM and
  // contract components are built from the other inputs.
  brief?: ExplorationBrief;

  // The live DEV base URL. Required for DOM capture; absent → DOM component is skipped.
  baseUrl?: string;

  // The e2e project directory (houses pinned Playwright + baked browsers). Required for
  // DOM capture. Absent → DOM component is skipped.
  e2eDir?: string;

  // The architecture map (context.json). Used to filter contract facts to the routes/
  // operations the brief identified. Optional — contracts component is skipped when absent.
  contextMap?: ArchitectureContext;

  // The union of changed files across the PR's full commit range (PR-aware ingestion,
  // Slice G). Used to further filter contracts to operations touched by the PR. When
  // absent, the brief's own routes/feBe are the only filter.
  prChangedFiles?: string[];

  // Slice 1 (agent-grounding-change-anchor): the typed signals extracted from the diff
  // (or guidance noun-phrases in MANUAL mode). Threaded to captureDomForRoutes as the
  // optional 4th arg, which forwards it to formatDomSnapshot for [CHANGED: …] annotation.
  // Absent/empty → no annotation; output is byte-identical to today.
  changedElements?: ChangedElement[];
}

export interface ContextPackResult {
  // The assembled text block for the "context-pack" VOLATILE section. Undefined when
  // the pack is entirely empty (all three components failed or absent).
  text: string | undefined;

  // Per-component byte counts for telemetry (section_sizes contribution).
  blastRadiusBytes: number;
  domBytes: number;
  contractBytes: number;
}

export interface ContextPackDeps {
  captureDomForRoutes(
    routes: string[],
    input: { e2eDir: string; baseUrl?: string },
    domDeps: CaptureDomDeps,
    changed?: ChangedElement[],
  ): Promise<string | undefined>;
  domDeps: CaptureDomDeps;
  log?: (msg: string) => void;
}

// ── Default deps ──────────────────────────────────────────────────────────────

import { defaultCaptureDomDeps } from "./dom-snapshot";

export const defaultContextPackDeps: ContextPackDeps = {
  captureDomForRoutes,
  domDeps: defaultCaptureDomDeps,
  log: (msg) => console.log(msg),
};

// ── DOM budget ────────────────────────────────────────────────────────────────

// FIXED DOM budget for the pack (30 KB ≈ ~500 lines at ~60 chars/line). This replaces the old
// 4×60 = 240-line fixed cap (P10 fix). It is NOT caller-configurable (FIX 7: the prior
// `domBudgetBytes` override was never passed by any caller — dead plumbing, now removed). The
// assembler's global per-prompt budget further bounds the pack SECTION when the total prompt is
// too large (and FIX 5 makes the pack least-shedable so the diff is shed before it).
const DOM_BUDGET_BYTES = 30_000;

// Approximation: bytes ≈ chars for ASCII-dominant text (the a11y tree is plain text).
const BYTES_PER_CHAR = 1;

// ── Contract filtering ────────────────────────────────────────────────────────

// Filter the architecture map's API operations to those the brief identified as relevant.
// Two filters:
//   (1) Operations referenced in the brief's feBe links (route→operationId pairs).
//   (2) Operations whose path overlaps with PR-changed file paths (string-contains, same
//       rationale as renderArchitectureContext's relevantLinks filter).
// An absent contextMap or empty brief yields an empty list — contracts component is skipped.
function filterRelevantContracts(
  contextMap: ArchitectureContext | undefined,
  brief: ExplorationBrief | undefined,
  prChangedFiles: string[] | undefined,
): ApiOperation[] {
  if (!contextMap || !contextMap.api?.length) return [];

  const relevantIds = new Set<string>();

  // From the brief's FeBe links (the most precise signal: the explorer resolved them from code).
  if (brief?.feBe?.length) {
    for (const link of brief.feBe) {
      if (link.operationId) relevantIds.add(link.operationId);
    }
  }

  // From the brief's contract facts (already scoped to the objective).
  if (brief?.contracts?.length) {
    for (const c of brief.contracts) {
      if (c.operationId) relevantIds.add(c.operationId);
    }
  }

  // From PR changed files: any operation whose path overlaps with changed file paths.
  // Only meaningful terms (>= 3 chars) to avoid false positives from short path segments.
  if (prChangedFiles?.length && contextMap.feBe?.length) {
    for (const link of contextMap.feBe) {
      const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
      if (prChangedFiles.some((f) => terms.some((t) => f.includes(t)))) {
        relevantIds.add(link.operationId);
      }
    }
  }

  if (relevantIds.size === 0) return [];
  return contextMap.api.filter((op) => relevantIds.has(op.operationId)).slice(0, 50);
}

// ── Renderers ─────────────────────────────────────────────────────────────────

const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

function renderBlastRadius(brief: ExplorationBrief): string {
  if (!brief.blastRadius.length) return "";
  const lines: string[] = ["### Blast radius (code — distilled from Serena)"];
  for (const n of brief.blastRadius.slice(0, 200)) {
    lines.push(`- \`${s(n.symbol)}\` (${s(n.file)}) — ${s(n.role)}`);
  }
  if (brief.feBe?.length) {
    lines.push("### FE↔BE links");
    for (const l of brief.feBe.slice(0, 50)) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
  }
  if (brief.risks?.length) {
    lines.push("### Risks / assert to catch regression");
    for (const r of brief.risks.slice(0, 20)) lines.push(`- ${s(r)}`);
  }
  return lines.join("\n");
}

function renderContracts(ops: ApiOperation[]): string {
  if (!ops.length) return "";
  const lines: string[] = ["### Relevant API contracts (from context.json — assert these at the boundary)"];
  for (const op of ops) {
    lines.push(`- \`${s(op.operationId)}\`: ${s(op.method)} ${s(op.path)}${op.service ? ` (${s(op.service)})` : ""}`);
  }
  return lines.join("\n");
}

// ── Main assembler ────────────────────────────────────────────────────────────

// Assemble the Context Pack for ONE objective/session. Best-effort: components that
// fail or are absent produce empty strings; the pack is returned as undefined only when
// ALL components are empty (pack would be noise-free but invisible — better to skip).
export async function buildContextPack(
  input: ContextPackInput,
  deps: ContextPackDeps,
): Promise<ContextPackResult> {
  const log = deps.log ?? (() => {});
  // FIX 7: the DOM component is capped at a FIXED budget (DOM_BUDGET_BYTES). No caller ever supplied
  // a per-call budget, so the old `domBudgetBytes` plumbing was dead — it has been removed and the
  // docstring corrected. The assembler's global per-prompt budget is the OUTER bound applied later
  // when the pack section is shed/truncated (and FIX 5 keeps the pack least-shedable there).
  const domBudgetChars = Math.floor(DOM_BUDGET_BYTES / BYTES_PER_CHAR);

  // Component (a): blast-radius from the ExplorationBrief.
  let blastSection = "";
  if (input.brief && input.brief.blastRadius.length > 0) {
    blastSection = renderBlastRadius(input.brief);
  }

  // Component (b): DOM slice — captured orchestrator-side via Playwright.
  // Candidate routes for DOM capture = brief's code-derived routes (ALL, regardless of
  // r.verified) UNION contextMap routes that overlap the diff's changed files. The qa-explorer
  // agent runs without a browser so verified is ALWAYS false (by design — see qa-explorer.md);
  // requiring verified=true meant DOM was never captured. Fix: capture all candidate routes
  // best-effort; a route that fails to load yields no DOM for that path (graceful degradation).
  // Cap: top DOM_ROUTE_CAP routes most relevant to the objective (bounds cost: ~15s/route).
  const DOM_ROUTE_CAP = 6;
  let domSection = "";
  // Build candidate set: brief routes (all, no verified filter) + contextMap routes.
  const briefRoutePaths = new Set<string>(
    (input.brief?.routes ?? [])
      .filter((r) => r.path)
      .map((r) => r.path),
  );
  // Include contextMap routes that the diff/brief touched (feBe route overlap).
  // This ensures routes relevant to the current objective are captured even when the brief
  // has no routes (e.g., empty blast-radius for a trivial commit).
  const contextMapRoutes = new Set<string>();
  if (input.contextMap?.feBe?.length && input.brief?.feBe?.length) {
    const briefOps = new Set(input.brief.feBe.map((l) => l.operationId));
    for (const link of input.contextMap.feBe) {
      if (briefOps.has(link.operationId) && link.route) contextMapRoutes.add(link.route);
    }
  }
  // Merge: brief routes first (more precise, code-derived), then contextMap routes.
  const candidateRoutes = [...briefRoutePaths, ...contextMapRoutes].filter(Boolean);
  // Cap to DOM_ROUTE_CAP most relevant routes (briefRoutes first = highest relevance).
  const briefRoutes = candidateRoutes.slice(0, DOM_ROUTE_CAP);
  if (briefRoutes.length > 0 && input.e2eDir && input.baseUrl) {
    try {
      const raw = await deps.captureDomForRoutes(briefRoutes, { e2eDir: input.e2eDir, baseUrl: input.baseUrl }, deps.domDeps, input.changedElements);
      if (raw) {
        // Budget the DOM: split into lines, apply capDomLines (table/list priority), then
        // reconstruct. This replaces the fixed 4×60 cap with a byte-budget-aware slice.
        const lines = raw.split("\n");
        const maxLines = Math.max(10, Math.floor(domBudgetChars / 60)); // ~60 chars/line estimate
        const { kept, dropped } = capDomLines(lines, maxLines);
        domSection = [
          "### Live DOM (a11y tree — GROUND TRUTH for selectors)",
          "These roles + accessible names are what the browser ACTUALLY exposes.",
          "Author selectors ONLY from what appears here — if a role is absent, it is NOT in the tree.",
          kept.join("\n"),
          ...(dropped > 0 ? [`(${dropped} non-priority element(s) omitted — see the full tree with the Playwright MCP if needed)`] : []),
        ].join("\n");
        log(`[qa] context-pack: DOM captured ${kept.length} lines for ${briefRoutes.length} route(s)${dropped > 0 ? ` (${dropped} omitted)` : ""}`);
      } else {
        log(`[qa] context-pack: DOM capture returned nothing for routes [${briefRoutes.join(", ")}] — grounding skipped`);
      }
    } catch (err) {
      log(`[qa] context-pack: DOM capture FAILED (${err instanceof Error ? err.message : String(err)}) — grounding skipped`);
    }
  }

  // Component (c): relevant API contracts.
  let contractSection = "";
  const relevantOps = filterRelevantContracts(input.contextMap, input.brief, input.prChangedFiles);
  if (relevantOps.length > 0) {
    contractSection = renderContracts(relevantOps);
    log(`[qa] context-pack: ${relevantOps.length} relevant API contract(s) included`);
  }

  // Assemble the pack.
  const blastRadiusBytes = Buffer.byteLength(blastSection, "utf8");
  const domBytes = Buffer.byteLength(domSection, "utf8");
  const contractBytes = Buffer.byteLength(contractSection, "utf8");

  const parts = [blastSection, domSection, contractSection].filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
  }

  const packHeader = [
    "## Context Pack (pushed by the orchestrator before the first write)",
    "",
    "This pack is the ground truth for this objective. It was built deterministically by",
    "the orchestrator BEFORE this session started. Use it to transcribe real selectors and",
    "verify blast-radius symbols; do NOT re-navigate routes already covered here or re-read",
    "code symbols already in the blast-radius section (the brief already distilled them).",
    "If the pack is absent for a route, fall back to the Playwright MCP to explore it yourself.",
    "",
  ].join("\n");

  const text = packHeader + parts.join("\n\n");
  return { text, blastRadiusBytes, domBytes, contractBytes };
}

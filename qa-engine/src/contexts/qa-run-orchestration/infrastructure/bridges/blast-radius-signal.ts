// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts
//
// Design §5.2 (Slice 4b.1): a PURE function rendering the three CodeGraphPort structural results
// (impactedSymbols, callersOf, coChangeCoupling) into ONE advisory markdown block, threaded through
// GenerationEnrichment.staticSignal -> OpencodeRunInput.staticSignal -> prompts.ts's existing
// "static-signal" section (ADR-2, ADR-3). Mirrors legacy renderStaticSignal (src/qa/static-signal/
// render.ts) byte-for-byte in DISCIPLINE, not content: per-section MAX_ITEMS cap, whole-block
// MAX_LEN byte budget truncated at the last newline boundary, every cell sanitized, and — the
// fail-open contract this port's advisory boundary requires — an empty composition renders "" so no
// section is added to the prompt (never a fabricated "no blast radius found" claim, R10).
//
// No IO here: the caller (StructuralSignalPortAdapter) is responsible for calling the three
// CodeGraphPort methods, degrading any err(CodeGraphUnavailable) to an empty array for that field,
// and handing the three (possibly-empty) arrays to this function.
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";

const MAX_ITEMS = 200;
const MAX_LEN = 20_000;

// Callers may optionally attach a confidence score (the CALLS edge confidence the adapter already
// filtered by) so this renderer can order by it — highest-confidence first, mirroring the design's
// "impacted by descending edge confidence" ordering rule (§5.2). Confidence is OPTIONAL: a caller
// that has no per-symbol confidence to report (or already discarded it) simply omits the field, and
// ordering degrades to input order (never fabricated).
export type ScoredSymbolRef = LocalSymbolRef & { confidence?: number };

export interface BlastRadiusSignalInput {
  impacted: readonly ScoredSymbolRef[];
  callers: readonly ScoredSymbolRef[];
  coupled: readonly CoupledFile[];
}

const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

function renderSymbolBlock(heading: string, refs: readonly ScoredSymbolRef[]): string[] {
  if (refs.length === 0) return [];
  const sorted = [...refs].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const lines: string[] = [`### ${heading} (${refs.length})`];
  for (const ref of sorted.slice(0, MAX_ITEMS)) {
    lines.push(`- \`${s(ref.symbol)}\` (${s(ref.file)})`);
  }
  lines.push("");
  return lines;
}

function renderCoupledBlock(coupled: readonly CoupledFile[]): string[] {
  if (coupled.length === 0) return [];
  const sorted = [...coupled].sort((a, b) => b.couplingScore - a.couplingScore);
  const lines: string[] = [`### Files that historically co-change (${coupled.length})`];
  for (const c of sorted.slice(0, MAX_ITEMS)) {
    const last = c.lastCoChange ? `, last ${s(c.lastCoChange)}` : "";
    lines.push(`- ${s(c.file)} (coupling ${c.couplingScore.toFixed(2)}, ${c.coChanges} co-changes${last})`);
  }
  lines.push("");
  return lines;
}

/** Cuts a UTF-8 buffer to at most MAX_LEN bytes (including the truncation marker), at the last
 *  newline boundary, so the output never ends in a dangling half-line. Byte-for-byte port of
 *  legacy renderStaticSignal's own truncation logic (src/qa/static-signal/render.ts). */
function truncateToByteBudget(out: string): string {
  const marker = "\n…(structural blast radius truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= MAX_LEN) return out;
  let cut = MAX_LEN - markerBytes - 1;
  while (cut > 0 && buf[cut] !== 0x0a /* '\n' */) cut--;
  const body = buf.subarray(0, cut + 1).toString("utf8");
  return body + marker;
}

/** Renders the advisory "Structural blast radius" section, or "" when there is nothing to say
 *  (design §5.2, R10 fail-open). Pure — no IO, no throws. */
export function renderBlastRadiusSignal(input: BlastRadiusSignalInput): string {
  const has = input.impacted.length > 0 || input.callers.length > 0 || input.coupled.length > 0;
  if (!has) return "";

  const lines: string[] = [];
  lines.push("## Structural blast radius (deterministic — from the code graph, advisory)");
  lines.push(
    "Derived from the indexed call graph at confidence >= 0.55. This is generation GUIDANCE, not a gate — verify against the live code. Absent edges (e.g. Lombok accessors) do NOT imply no dependency.",
  );
  lines.push("");
  lines.push(...renderSymbolBlock("Impacted symbols", input.impacted));
  lines.push(...renderSymbolBlock("Callers of the changed code", input.callers));
  lines.push(...renderCoupledBlock(input.coupled));

  const out = lines.join("\n");
  return truncateToByteBudget(out);
}

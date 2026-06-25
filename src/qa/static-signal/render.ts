import { sanitizeText } from "../../orchestrator/sanitizer";
import type { StaticSignal } from "./types";
const MAX_ITEMS = 200;
const MAX_LEN = 20_000;
export function renderStaticSignal(sig: StaticSignal): string {
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const has = sig.symbols.length || sig.relations.length || sig.complexity.length || sig.patterns.length || sig.fileChangeKinds.some((f) => f.cosmetic);
  if (!has) return "";
  const lines: string[] = [];
  lines.push("## Static analysis (deterministic — pre-computed from the diff)");
  lines.push(`Built for ${s(sig.builtForSha).slice(0, 7)} over ${sig.languages.join(", ") || "no supported language"}. This is GROUND TRUTH about the code structure — use it to target assertions; you need not re-derive it.`);
  lines.push("");
  const cosmetic = sig.fileChangeKinds.filter((f) => f.cosmetic).slice(0, MAX_ITEMS);
  if (cosmetic.length) { lines.push("### Cosmetic-only changes (whitespace/comments — deprioritize)"); for (const f of cosmetic) lines.push(`- ${s(f.file)}`); lines.push(""); }
  if (sig.symbols.length) { lines.push(`### Changed symbols (${sig.symbols.length})`); for (const sym of sig.symbols.slice(0, MAX_ITEMS)) lines.push(`- \`${s(sym.signature)}\` (${s(sym.file)}:${sym.line})`); lines.push(""); }
  if (sig.relations.length) { lines.push(`### Relations between changed files (${sig.relations.length})`); for (const r of sig.relations.slice(0, MAX_ITEMS)) lines.push(`- ${s(r.from)} → ${s(r.to)} (via ${s(r.via)})`); lines.push("Test the flows that cross these edges, not each file in isolation."); lines.push(""); }
  if (sig.complexity.length) { lines.push(`### Complexity hotspots (higher ccn = more paths → more cases needed)`); for (const c of sig.complexity.slice(0, MAX_ITEMS)) lines.push(`- ${s(c.function)} (${s(c.file)}:${c.line}) — ccn ${c.ccn}, ${c.nloc} loc`); lines.push(""); }
  if (sig.patterns.length) { lines.push(`### Change patterns`); for (const p of sig.patterns.slice(0, MAX_ITEMS)) lines.push(`- ${s(p.pattern)} (${s(p.file)})`); lines.push(""); }
  const out = lines.join("\n");
  // D4: truncate on a byte budget (not char offset) and cut at the last newline boundary so the
  // section never ends in a dangling half-line. The assembler budgets in bytes, so a char-based
  // slice can emit more bytes than the limit and can also bisect a multi-byte sequence or a
  // mid-line entry (e.g. mid-`###` heading). Cutting at the preceding `\n` avoids both problems.
  const marker = "\n…(static signal truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= MAX_LEN) return out;
  // Walk back from (MAX_LEN - markerBytes - 1) to find the last newline. Starting one byte BELOW
  // (MAX_LEN - markerBytes) guarantees body (cut+1 bytes) + marker stays ≤ MAX_LEN even when that
  // boundary byte is itself a newline — the off-by-one that would otherwise emit MAX_LEN + 1 bytes.
  let cut = MAX_LEN - markerBytes - 1;
  while (cut > 0 && buf[cut] !== 0x0a /* '\n' */) cut--;
  // Include the newline itself in the surviving body so body ends with '\n'.
  const body = buf.subarray(0, cut + 1).toString("utf8");
  return body + marker;
}

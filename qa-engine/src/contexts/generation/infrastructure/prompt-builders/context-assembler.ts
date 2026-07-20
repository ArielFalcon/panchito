// ContextAssembler — the single authority for building boundary prompts.
//
// Every agent boundary prompt (generator, worker, planner, reviewer) is assembled
// here from a declarative list of Section descriptors. The assembler enforces:
//
//   [STABLE prefix]    role + working-rules + mode-rules + critical instructions
//   [SEMI-STABLE]      architecture map + contracts + diff scope
//   [VOLATILE]         DOM slice / reviewer prior-corrections / fix feedback
//   [TASK]             objective + acceptance criterion
//   [CRITICAL recap]   the few non-negotiable rules, repeated at the end
//
// This canonical order (P3 fix) puts the cache-stable prefix first (improves cache
// opportunity for repeated same-role calls), task and ground-truth near the end
// (where the agent needs them at write time), and brackets critical rules top+bottom
// to counter the lost-in-the-middle effect.
//
// Sections can carry a `language` tag (`scaffold` | `verbatim`). `scaffold` sections
// are the system's own English prose; `verbatim` sections carry user-supplied content
// (manual guidance, raw diff) that must be passed through as-is. This is the P4 fix:
// the assembler stamps English on its own structure while leaving user content alone.
//
// Per-section byte caps (`maxBytes`) are the P5 hygiene fix. When a section exceeds
// its cap, the section's `overflow` policy determines what happens:
//   `drop`      → the whole section is OMITTED (no half-truncated content that could
//                 read as a different instruction than intended).
//   `summarize` → there is no summarizer in this phase, so it DEGRADES to truncation
//                 with a visible marker (same path as an in-budget cap). The full
//                 budget engine (Slice F, Phase 2) — which resolves caps against the
//                 role's model-window catalog and adds real summarization — supersedes this.
//
// `assemble()` returns the assembled string AND a per-section size map
// (`sectionSizes`) that is emitted to the Phase-0 turn telemetry so every boundary
// prompt is observable by section.

// Phase 2 / Slice F — Global byte budget enforcement.
//
// `assemble()` now accepts an optional `budgetBytes` option (the per-role total
// prompt budget derived from the model-window catalog in model-window-catalog.ts).
// When supplied, the assembler enforces a GLOBAL ceiling on the assembled prompt:
//
//   1. Resolve every section's content (lazy producers called once) and apply
//      per-section maxBytes caps (the Phase-1 per-section hygiene).
//   2. Compute the total assembled size. If it fits within `budgetBytes`, emit as
//      usual.
//   3. If the total EXCEEDS `budgetBytes`, shed sections in ASCENDING priority order
//      within each role band (highest priority number = lowest priority = shed first),
//      applying their `overflow` policy:
//        "drop"      → omit the whole section (logged).
//        "summarize" → degrades to truncation with a visible marker (Phase-2 fallback;
//                      a real summarizer is a future phase).
//      Shedding repeats until the total fits or all shedable sections are exhausted.
//   4. Every shed event is LOGGED (no silent truncation). The log includes the
//      section id, original byte count, and the action taken.
//
// This adds a SECOND, OUTER enforcement layer on top of the per-section maxBytes
// (the inner layer). The outer budget is the model's effective input window
// (catalog window × safety margin × 4 bytes/token). The inner caps are preserved
// for section-local hygiene (a reviewer-corrections section, for example, has its
// own cap regardless of the total budget).
//
// Sections with `maxBytes = 0` (uncapped) that are not shed by the global budget
// remain uncapped — the global budget is the only ceiling for those sections.
//
// The global budget DOES NOT replace the per-section caps (those are additive
// hygiene): it adds an outer guarantee. This means a prompt never exceeds the
// role's configured budget, but sections can still be individually capped below it.

import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";

// Options for assemble().
export interface AssembleOpts {
  // Global byte budget for the assembled prompt. When provided and positive, the
  // assembler sheds lowest-priority sections until the total fits within this limit.
  // 0 or absent means no global budget enforcement (Phase-1 behaviour, unchanged).
  budgetBytes?: number;
}

// The structural role of a section in the canonical order.
// Numeric values define sort order among sections with the same role.
export type SectionRole =
  | "stable-prefix"   // 1: role identity + working-rules + mode-rules + critical top
  | "semi-stable"     // 2: architecture map + contracts + diff scope
  | "volatile"        // 3: DOM slice / prior-corrections / fix feedback
  | "task"            // 4: objective + acceptance criterion
  | "critical-recap"; // 5: critical rules repeated at the end

// Internal role order used for sorting.
const ROLE_ORDER: Record<SectionRole, number> = {
  "stable-prefix": 1,
  "semi-stable": 2,
  "volatile": 3,
  "task": 4,
  "critical-recap": 5,
};

// A declared section submitted by a prompt builder. The assembler owns canonical
// ordering, byte-budget enforcement, and section_sizes telemetry — the builder
// just declares what content it wants in which slot.
export interface Section {
  // Unique identifier for this section in telemetry (e.g. "working-rules", "diff", "task").
  id: string;
  // Structural role that determines canonical position.
  role: SectionRole;
  // Priority within the same role band (lower = higher priority = survives overflow first).
  priority: number;
  // Maximum byte length for this section. 0 means uncapped.
  maxBytes: number;
  // The section's content (static string or a lazy producer).
  content: string | (() => string);
  // Whether the content is cacheable (purely informational for future Phase-2 optimizations).
  cacheable?: boolean;
  // Overflow policy when content exceeds maxBytes.
  overflow: "summarize" | "drop";
  // Language tag: `scaffold` = this repo's English prose; `verbatim` = user-supplied content.
  language: "scaffold" | "verbatim";
  // FIX 5: optional override of the SHED-ORDER band (NOT the canonical assembly order, which is
  // always ROLE_ORDER). When set, the global-budget pass treats the section as if it were in this
  // SectionRole's shed band instead of its own. This lets a section that is positioned in the
  // VOLATILE band for READING (near the task) survive shedding as if it were less shedable — the
  // case for the Context Pack: it is DOM ground-truth NOT recoverable by the agent, so it must
  // outlast the raw diff (recoverable via `git show`) which lives in the TASK band. Assembly order
  // is unchanged; only the shed precedence moves.
  shedAs?: SectionRole;
}

// Result of assembling a prompt.
export interface AssembledPrompt {
  // The fully assembled prompt string.
  text: string;
  // Per-section size map: section_id -> byte length of the (possibly capped) content.
  sectionSizes: Record<string, number>;
}

// Truncate a UTF-8 buffer to at most `maxBytes`, stripping any trailing bytes that form an
// INCOMPLETE multi-byte sequence. `buf.subarray(0, maxBytes).toString("utf8")` would instead
// decode a split sequence into a U+FFFD replacement char AND can emit MORE bytes than maxBytes
// (U+FFFD is 3 bytes) — so the truncated content is neither clean nor a true ceiling. By cutting
// at a UTF-8 sequence boundary we return valid text whose byte length is guaranteed ≤ maxBytes.
function truncateToValidUtf8(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  // Walk back off any continuation bytes (0b10xxxxxx); then, if we're sitting on a lead byte whose
  // full sequence would run past `end`, drop that lead byte too. The result is a whole number of
  // complete code points and never exceeds maxBytes.
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) end--;
  if (end > 0) {
    const lead = buf[end - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (seqLen > 1 && end - 1 + seqLen > Math.min(maxBytes, buf.length)) end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

// Cap a string to `maxBytes` bytes (UTF-8). Returns the original string when the cap
// is 0 or when the string is already within the cap. Otherwise the section content is
// truncated at a UTF-8 boundary (a true byte ceiling, no U+FFFD replacement char) and a
// visible marker is appended so the observer knows the section was capped.
function capToBytes(text: string, maxBytes: number, sectionId: string): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const truncated = truncateToValidUtf8(buf, maxBytes);
  console.warn(
    `[context-assembler] section '${sectionId}' truncated from ${buf.length} to ${maxBytes} bytes (overflow='summarize' degrades to truncation).`,
  );
  return truncated + `\n…(section '${sectionId}' capped at ${maxBytes} bytes)`;
}

// Assemble the declared sections into a single prompt string following the canonical
// structure. Returns the prompt text and a per-section size map for telemetry.
//
// When `opts.budgetBytes` is positive, a GLOBAL byte-budget enforcement pass runs
// BEFORE final assembly: sections are shed (lowest priority first) until the total
// fits. Every shed event is logged with section id, original bytes, and action.
// See the module header for the full Phase-2 budget enforcement description.
//
// migration-tier-4c Slice 5b (D-4c-6 twin wiring): renamed to `assembleImpl` — the PUBLIC `assemble`
// export below now delegates through the (previously dormant) `ContextAssemblerAdapter`, giving that
// class a genuine, permanently-exercised production caller instead of parity-test-only. Pure
// relocation of behavior: this function's body is byte-for-byte unchanged.
function assembleImpl(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  // Sort by canonical role order, then by priority within each role.
  const sorted = [...sections].sort((a, b) => {
    const ra = ROLE_ORDER[a.role];
    const rb = ROLE_ORDER[b.role];
    if (ra !== rb) return ra - rb;
    return a.priority - b.priority;
  });

  // ── Phase 1: Per-section resolution and inner-cap enforcement ───────────────
  // Resolve each section to its (possibly capped) content. This is the Phase-1
  // per-section maxBytes hygiene layer. The result is a list of resolved entries
  // that the global-budget pass (Phase 2) then prunes if needed.
  interface ResolvedSection {
    section: Section;
    content: string; // resolved and inner-capped content (may be empty → will be dropped)
    dropped: boolean; // true if the inner cap already dropped this section
  }

  const resolved: ResolvedSection[] = [];
  for (const sec of sorted) {
    // Resolve content (lazy producer or static string).
    const raw = typeof sec.content === "function" ? sec.content() : sec.content;
    // Skip empty sections (no-op: don't add blank blocks or size entries for absent content).
    if (!raw) continue;

    // Inner-cap enforcement (Phase 1 per-section maxBytes):
    //   "drop"      → OMIT the whole section.
    //   "summarize" → degrades to truncation with a marker (no real summarizer yet).
    const overInnerBudget = sec.maxBytes > 0 && Buffer.byteLength(raw, "utf8") > sec.maxBytes;
    if (overInnerBudget && sec.overflow === "drop") {
      console.warn(
        `[context-assembler] section '${sec.id}' (${Buffer.byteLength(raw, "utf8")} bytes) exceeds maxBytes ${sec.maxBytes} and overflow='drop' — omitting the whole section.`,
      );
      resolved.push({ section: sec, content: "", dropped: true });
      continue;
    }

    // "summarize" (degrades to truncation) and the in-budget case both go through capToBytes.
    const capped = capToBytes(raw, sec.maxBytes, sec.id);
    resolved.push({ section: sec, content: capped, dropped: false });
  }

  // ── Phase 2: Global byte-budget enforcement ──────────────────────────────────
  // When a budget is provided and the total assembled size would exceed it, shed
  // the lowest-priority sections (by descending priority number within each role
  // band, so the highest numeric priority = lowest value = first to go) until the
  // total fits. Shedding follows each section's overflow policy.
  //
  // D1+D2: track section ids dropped by the budget pass. After assembly, if any were dropped,
  // a small always-surviving notice is appended to the output naming them. This tells the agent
  // exactly which context sections it did NOT receive so it can explore them directly rather
  // than assuming their content is absent.
  const droppedIds: string[] = [];
  const budgetBytes = opts.budgetBytes ?? 0;
  if (budgetBytes > 0) {
    // Compute total bytes of the assembled prompt (surviving sections joined by "\n").
    // The join adds (survivingCount - 1) separator bytes. We include them so the budget
    // check reflects the actual assembled size accurately.
    const totalBytes = () => {
      const surviving = resolved.filter((r) => !r.dropped && r.content);
      const contentBytes = surviving.reduce((sum, r) => sum + Buffer.byteLength(r.content, "utf8"), 0);
      const separatorBytes = surviving.length > 1 ? surviving.length - 1 : 0;
      return contentBytes + separatorBytes;
    };

    if (totalBytes() > budgetBytes) {
      // Build shed candidates: surviving sections sorted by descending priority within
      // their role band (highest priority number = lowest importance = shed first).
      // Sections in stable-prefix and critical-recap are shed LAST (they are small and
      // load-bearing for every prompt). VOLATILE and SEMI-STABLE are shed before TASK
      // and before STABLE/RECAP.
      const SHED_ROLE_ORDER: Record<SectionRole, number> = {
        "volatile": 1,        // shed first (ground-truth is per-run; most replaceable)
        "semi-stable": 2,     // shed second (architecture context, diff scope)
        "task": 3,            // shed third (only when nothing else can be removed)
        "stable-prefix": 4,   // shed last (system rules — shedding breaks the role)
        "critical-recap": 4,  // shed last (output contract — shedding breaks the role)
      };

      // Note: totalBytes() counts section content bytes only. The final assembly joins
      // sections with "\n" (1 byte per join). To avoid off-by-one errors in the budget
      // check, we add the join overhead to the cap marker's overhead estimate. In practice,
      // the few-byte discrepancy from separators is negligible relative to the budget
      // (which is measured in hundreds of kilobytes), so totalBytes() provides a
      // sufficiently accurate budget estimate for shedding decisions.

      // Sort shed candidates: primary key = shed-role order (most shedable first),
      // secondary key = priority number (highest = least important = shed first).
      // FIX 5: a section may override its shed band via `shedAs` (assembly order is untouched). The
      // Context Pack sits in VOLATILE for reading but sheds as CRITICAL-RECAP (least-shedable), so the
      // raw diff (in TASK, recoverable via `git show`) goes before the unrecoverable DOM ground-truth.
      const shedBand = (s: Section): number => SHED_ROLE_ORDER[s.shedAs ?? s.role];
      const candidates = resolved
        .filter((r) => !r.dropped)
        .sort((a, b) => {
          const roleA = shedBand(a.section);
          const roleB = shedBand(b.section);
          if (roleA !== roleB) return roleA - roleB;
          return b.section.priority - a.section.priority; // higher priority number → shed first
        });

      for (const candidate of candidates) {
        if (totalBytes() <= budgetBytes) break;

        const originalBytes = Buffer.byteLength(candidate.content, "utf8");

        if (candidate.section.overflow === "drop") {
          // Drop: omit the entire section.
          console.warn(
            `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
              `(${originalBytes} bytes, overflow='drop') — total was ${totalBytes()} bytes, ` +
              `budget is ${budgetBytes} bytes.`,
          );
          candidate.dropped = true;
          // Clear content so totalBytes() recalculation reflects the shed.
          candidate.content = "";
          // D1+D2: record this drop so the shed-notice can name the missing section.
          droppedIds.push(candidate.section.id);
        } else {
          // "summarize" degrades to truncation: truncate to fill the remaining budget.
          // FIX 8d / production note: there is NO real summarizer in this phase — "summarize" always
          // means TRUNCATE-with-a-visible-marker, never an actual condensed rewrite. This branch IS
          // taken in production: the reviewer's load-bearing sections (reviewer-objective, reviewer-dom,
          // reviewer-specs in prompts.ts) opt into overflow:"summarize" specifically so a residual
          // overflow degrades to a visible truncation instead of a silent whole-section drop.
          // The remaining budget is the total budget minus the bytes of all OTHER surviving sections.
          // We must reserve space for the cap marker that capToBytes appends:
          //   marker = `\n…(section '{id}' capped at {N} bytes)`
          // We pre-compute the marker overhead so the TOTAL (truncated content + marker) fits.
          const remainingBudget = budgetBytes - (totalBytes() - originalBytes);
          if (remainingBudget <= 0) {
            // No room at all: drop entirely.
            console.warn(
              `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
                `(${originalBytes} bytes, overflow='summarize' → no room → dropping entirely) — ` +
                `total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
            );
            candidate.dropped = true;
            candidate.content = "";
            // D1+D2: record this drop so the shed-notice can name the missing section.
            droppedIds.push(candidate.section.id);
          } else {
            // capToBytes appends a marker of the form `\n…(section '{id}' capped at {N} bytes)`.
            // Estimate the marker byte overhead conservatively (64 bytes covers any realistic id).
            const markerOverhead = Buffer.byteLength(
              `\n…(section '${candidate.section.id}' capped at ${remainingBudget} bytes)`,
              "utf8",
            );
            // The content target is remainingBudget minus the marker overhead.
            // If the target is ≤ 0 there is truly no room; drop entirely.
            const contentTarget = remainingBudget - markerOverhead;
            if (contentTarget <= 0) {
              console.warn(
                `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
                  `(${originalBytes} bytes, overflow='summarize' → no room after marker overhead → dropping entirely) — ` +
                  `total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.dropped = true;
              candidate.content = "";
            } else {
              const truncated = capToBytes(candidate.content, contentTarget, candidate.section.id);
              console.warn(
                `[context-assembler] BUDGET OVERFLOW: truncating section '${candidate.section.id}' ` +
                  `from ${originalBytes} to ${Buffer.byteLength(truncated, "utf8")} bytes ` +
                  `(overflow='summarize') — total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.content = truncated;
            }
          }
        }
      }

      if (totalBytes() > budgetBytes) {
        // Could not shed enough without removing load-bearing sections. Log it but
        // do not hard-fail — a prompt that is slightly over budget is better than
        // an aborted run. The operator can raise the budget or reduce section sizes.
        console.warn(
          `[context-assembler] BUDGET OVERFLOW: could not shed enough sections to meet ` +
            `${budgetBytes}-byte budget (remaining: ${totalBytes()} bytes). ` +
            `The assembled prompt exceeds the role budget — raise budgetBytes or reduce section sizes.`,
        );
      }
    }
  }

  // ── Final assembly: emit surviving sections ──────────────────────────────────
  const parts: string[] = [];
  const sectionSizes: Record<string, number> = {};

  for (const r of resolved) {
    if (r.dropped || !r.content) continue;
    // Record the byte size of the (possibly capped) content.
    sectionSizes[r.section.id] = Buffer.byteLength(r.content, "utf8");
    parts.push(r.content);
  }

  // D1+D2: if any sections were dropped by the global budget pass, append a small always-surviving
  // notice naming the omitted ids. The notice is appended AFTER the budget check (it is NOT added
  // to `resolved` so it cannot itself be shed). It is intentionally tiny so it never meaningfully
  // impacts the budget. The agent learns which context sections it did NOT receive and can explore
  // them directly — do not assume they are absent just because they were not in the prompt.
  if (droppedIds.length > 0) {
    const notice =
      `⚠ Budget: these context sections were omitted and are NOT below: ${droppedIds.join(", ")}. ` +
      `If a flow needs DOM/structure/contracts you did not receive, explore it directly — do not assume it is absent.`;
    parts.push(notice);
  }

  return {
    text: parts.join("\n"),
    sectionSizes,
  };
}

// Convenience: build a Section with defaults filled in.
// `priority` defaults to 0. `maxBytes` defaults to 0 (uncapped).
// `overflow` defaults to "drop". `language` defaults to "scaffold".
// `cacheable` defaults to false.
//
// migration-tier-4c Slice 5b (D-4c-6 twin wiring): renamed to `sectionImpl` — see `assembleImpl`'s
// own doc above. Byte-for-byte unchanged.
function sectionImpl(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">> = {},
): Section {
  return {
    id,
    role,
    content,
    priority: opts.priority ?? 0,
    maxBytes: opts.maxBytes ?? 0,
    cacheable: opts.cacheable ?? false,
    overflow: opts.overflow ?? "drop",
    language: opts.language ?? "scaffold",
    ...(opts.shedAs ? { shedAs: opts.shedAs } : {}),
  };
}

// migration-tier-4c Slice 5b (D-4c-6 twin wiring): `ContextAssemblerAdapter` (qa-engine/contexts/
// generation/infrastructure/context-assembler.adapter.ts) was built AHEAD of this relocation — a
// thin, parity-tested pass-through class with ZERO production callers (only its own unit + parity
// tests exercised it; see the "wired means FED" lesson in this migration program's memory). Now that
// this file itself lives in qa-engine (no cross-boundary injection is needed for assemble/section —
// both sides of that boundary collapsed once prompts.ts + context-assembler.ts moved together), the
// adapter gets a genuine production call path here: EVERY `assemble`/`section` call (from prompts.ts
// and any future qa-engine caller) now routes through this one constructed instance. Pure
// indirection — `assembleImpl`/`sectionImpl` are unchanged, so behavior is byte-for-byte identical
// (already proven by context-assembler.adapter-parity.test.ts).
const defaultAssembler = new ContextAssemblerAdapter(assembleImpl, sectionImpl);

export function assemble(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  return defaultAssembler.assemble(sections, opts);
}

export function section(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">> = {},
): Section {
  return defaultAssembler.section(id, role, content, opts);
}

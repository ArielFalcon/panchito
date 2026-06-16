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
// its cap, the overflow policy (`summarize` | `drop`) determines what happens. In
// this Phase-1b implementation the assembler enforces the cap via truncation with a
// visible marker — the full budget engine (Slice F, Phase 2) resolves it against the
// role's model-window catalog.
//
// `assemble()` returns the assembled string AND a per-section size map
// (`sectionSizes`) that is emitted to the Phase-0 turn telemetry so every boundary
// prompt is observable by section.

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
}

// Result of assembling a prompt.
export interface AssembledPrompt {
  // The fully assembled prompt string.
  text: string;
  // Per-section size map: section_id -> byte length of the (possibly capped) content.
  sectionSizes: Record<string, number>;
}

// Cap a string to `maxBytes` bytes (UTF-8). Returns the original string when the cap
// is 0 or when the string is already within the cap.
function capToBytes(text: string, maxBytes: number, sectionId: string): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Truncate to maxBytes. Since UTF-8 can have multi-byte chars, work in bytes.
  const buf = Buffer.from(text, "utf8");
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  // Remove any partial multi-byte sequence at the end (Buffer.toString handles this gracefully
  // but we add a visible marker so the observer knows the section was capped).
  console.warn(
    `[context-assembler] section '${sectionId}' truncated from ${buf.length} to ${maxBytes} bytes (overflow policy applied).`,
  );
  return truncated + `\n…(section '${sectionId}' capped at ${maxBytes} bytes)`;
}

// Assemble the declared sections into a single prompt string following the canonical
// structure. Returns the prompt text and a per-section size map for telemetry.
export function assemble(sections: Section[]): AssembledPrompt {
  // Sort by canonical role order, then by priority within each role.
  const sorted = [...sections].sort((a, b) => {
    const ra = ROLE_ORDER[a.role];
    const rb = ROLE_ORDER[b.role];
    if (ra !== rb) return ra - rb;
    return a.priority - b.priority;
  });

  const parts: string[] = [];
  const sectionSizes: Record<string, number> = {};

  for (const section of sorted) {
    // Resolve content (lazy producer or static string).
    const raw = typeof section.content === "function" ? section.content() : section.content;
    // Skip empty sections (no-op: don't add blank blocks or size entries for absent content).
    if (!raw) continue;

    // Apply maxBytes cap.
    const capped = capToBytes(raw, section.maxBytes, section.id);

    // Record the byte size of the (possibly capped) content.
    sectionSizes[section.id] = Buffer.byteLength(capped, "utf8");

    parts.push(capped);
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
export function section(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language">> = {},
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
  };
}

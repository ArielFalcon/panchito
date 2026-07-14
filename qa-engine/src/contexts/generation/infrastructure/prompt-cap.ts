// qa-engine/src/contexts/generation/infrastructure/prompt-cap.ts
// THE REAL, src/-FREE PromptBudgetPort capDiff/capText fns — Sub-Plan 7.2 item 4 (closes the F.2
// GAP where shadow-run.operator.ts wired the SAME capText into BOTH the capDiff and capText slots
// because no distinct capDiff existed at the port).
//
// DECISION (verified before writing this module, not assumed): src/orchestrator/sanitizer.ts
// ALREADY ships a real, dedicated capDiff(diff, maxChars?) — a diff-aware, per-file-section capper,
// genuinely distinct from capText's flat prose truncation:
//   - capDiff splits the diff into per-file sections (`diff --git a/... b/...` boundaries), relevance-
//     orders them (high-relevance changed source FIRST; lockfiles/generated/snapshot/binary/build-
//     artifact/map/changelog files LAST — LOW_RELEVANCE_PATTERNS), keeps WHOLE sections until the
//     budget is spent, and replaces the rest with a named list of omitted files (never truncates a
//     hunk mid-line). A degenerate single-oversized-file overflow hard-slices that one section.
//   - capText has no per-file structure to preserve (it caps free-form prose, e.g. a commit body) —
//     a single hard slice with a truncation marker is correct for it.
// So there is NO "one capper for both" decision to make here: the real capDiff already exists in
// src/ and is ported VERBATIM below (including its relevance-ordering + omission-marker mechanics).
// Wiring the real capText into the capText slot AND the real capDiff into the capDiff slot is a
// faithful port of two ALREADY-DISTINCT real functions — not a fabrication.
//
// Deliberately scoped to ONLY the diff/text-capping concern: sanitizeText/containsSecrets/
// SECRET_AUDIT (secret redaction) stay in src/orchestrator/sanitizer.ts — that is a security
// boundary concern outside PromptBudgetPort's contract (capDiff/capText/budgetForRole), and porting
// it here would silently widen this module's scope beyond what Sub-Plan 7.2 item 4 asks for.

// ── Diff prompt budget (ported verbatim from sanitizer.ts) ──────────────────────────────────────
export const MAX_PROMPT_DIFF_CHARS = 50_000;

// File patterns that classify a diff section as low-relevance (sorted last / omitted first when the
// budget is tight). A section matching ANY of these is low-relevance. Ported verbatim.
const LOW_RELEVANCE_PATTERNS = [
  // Lockfiles (npm, yarn, pnpm, pip, cargo, go, composer, poetry, gemfile)
  /^(package-lock|yarn\.lock|pnpm-lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Gemfile\.lock)$/i,
  // Generated files (conventional suffixes / directory names)
  /\.(generated|gen|pb|pb\.go|pb_grpc\.go|swagger\.json|openapi\.json|openapi\.yaml)$/i,
  /\bgenerated?\b/i,
  // Snapshot / inline-snapshot test files
  /\.snap$/i,
  // Binary + media assets
  /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i,
  // Build artefacts and caches
  /\/(dist|build|\.cache|__pycache__|\.next|\.nuxt|\.out|target)\/[^/]+\.(js|css|map|ts)$/i,
  // Source-map files
  /\.map$/i,
  // Changelog and migration artefacts
  /^(CHANGELOG|CHANGES|HISTORY)\.(md|txt)$/i,
];

function isLowRelevance(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return LOW_RELEVANCE_PATTERNS.some((p) => p.test(filePath) || p.test(basename));
}

// Extracts the file path from a "diff --git a/... b/..." header line.
// migration-tier-4c Slice 5a: exported (was module-private) — prompts.ts's cappedDiffText
// (relocated from src/integrations/prompts.ts) needs this to pick a per-file-section sanitize mode
// (see prompts.ts's own diffSectionMode doc), the SAME file-header parsing capDiff already does
// internally below. No behavior change — this is the identical function, just no longer private.
export function extractDiffFilePath(section: string): string {
  // "diff --git a/src/foo.ts b/src/foo.ts" — take the b/ path (post-rename destination)
  const m = /^diff --git a\/\S+ b\/(\S+)/m.exec(section);
  return m?.[1] ?? "";
}

// Ported verbatim from sanitizer.ts's capDiff: keep whole per-file sections in RELEVANCE ORDER
// until the budget is spent, then replace the rest with the list of omitted files. The agent always
// has the full diff available in its working copy (`git show <sha>`), so nothing is lost — only the
// prompt is bounded.
export function capDiff(diff: string, maxChars: number = MAX_PROMPT_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  // Split into per-file sections; the leading chunk (before the first header) stays first.
  const rawSections = diff.split(/^(?=diff --git )/m);

  // Relevance-order: high-relevance (changed source) first, low-relevance last.
  // Stable sort preserves the original file order within each group.
  const preamble = rawSections[0] ?? "";
  const fileSections = rawSections.slice(1);
  const highRelevance: string[] = [];
  const lowRelevance: string[] = [];
  for (const s of fileSections) {
    const filePath = extractDiffFilePath(s);
    if (isLowRelevance(filePath)) {
      lowRelevance.push(s);
    } else {
      highRelevance.push(s);
    }
  }
  // Ordered: preamble + high-relevance sections + low-relevance sections.
  const ordered = [preamble, ...highRelevance, ...lowRelevance];

  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of ordered) {
    if (omitted.length === 0 && used + section.length <= maxChars) {
      kept.push(section);
      used += section.length;
    } else {
      if (section === preamble) continue; // preamble has no file header to name
      const file = extractDiffFilePath(section) || (/^diff --git a\/(\S+)/.exec(section)?.[1] ?? "(unnamed section)");
      omitted.push(file);
    }
  }
  // Degenerate single-section overflow (one giant file): hard-truncate the first section.
  if (kept.filter((s) => s !== preamble).length === 0 && fileSections.length > 0) {
    const firstFile = highRelevance[0] ?? lowRelevance[0] ?? fileSections[0]!;
    kept.push(firstFile.slice(0, maxChars));
    const name = extractDiffFilePath(firstFile);
    omitted.splice(omitted.indexOf(name), 1);
  }
  return (
    kept.join("") +
    `\n[diff truncated for the prompt: ${omitted.length} file(s) omitted (${diff.length} chars total).` +
    ` Omitted: ${omitted.join(", ")}.` +
    ` Read the full change in the working copy with \`git show <sha>\`.]\n`
  );
}

export const MAX_PROMPT_BODY_CHARS = 4_000;

// Ported verbatim from sanitizer.ts's capText: caps free-form prose (e.g. a commit body) before it
// enters a prompt. Unlike capDiff there is no per-file structure to preserve, so a single hard slice
// with a visible marker is correct.
export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}

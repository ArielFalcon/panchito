// THE ONE canonical diff parser. Consolidates the 3 diff-CONTENT parsers that drifted across src/:
//   parseDiffHunks (change-coverage.ts)  → changedLines
//   parseChangedFiles (commit-classify.ts) → changedFiles
//   changedFilesFromDiff (semantic-diff.ts) → modifiedFiles
// plus the user's changed-elements extraction (extractChangedElements/changedElementsFromGuidance).
// The git-STATUS parsers (parseStatusOutput/parsePorcelain) are NOT diffs and stay in their own
// bounded contexts. Pure: no I/O, no spawn, deterministic.
import type { ChangedLines } from "./changed-lines.ts";
import type { ChangedElement } from "./changed-element.ts";

export class DiffParserService {
  // Added/modified lines per file, numbered on the NEW side. Pure deletions contribute nothing.
  changedLines(diff: string): ChangedLines {
    const changed: ChangedLines = new Map();
    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git")) { file = null; inHunk = false; continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) {
        if (raw.startsWith("+++ ")) {
          const p = raw.slice(4).trim();
          file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
        }
        continue;
      }
      if (file === null) continue;
      const c = raw[0];
      if (c === "+") {
        let set = changed.get(file);
        if (!set) changed.set(file, (set = new Set()));
        set.add(newLine);
        newLine++;
      } else if (c === "-") { /* old side only */ }
      else if (c === "\\") { /* "\ No newline at end of file" */ }
      else { newLine++; }
    }
    return changed;
  }

  // Every changed path from the `diff --git a/X b/Y` headers (added, modified, deleted). Ported
  // from commit-classify.ts parseChangedFiles: prefer the b/ side, fall back to a/.
  changedFiles(diff: string): string[] {
    const files: string[] = [];
    for (const line of diff.split("\n")) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
      if (m) files.push(m[2] ?? m[1]!);
    }
    return files;
  }

  // Only files present on BOTH sides (modified). Ported from semantic-diff.ts changedFilesFromDiff:
  // a pure add (--- /dev/null) or pure delete (+++ /dev/null) is excluded.
  modifiedFiles(diff: string): string[] {
    const files: string[] = [];
    let basePath: string | null = null;
    let headPath: string | null = null;
    let afterDiffGit = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        if (basePath !== null && headPath !== null) files.push(headPath);
        afterDiffGit = true; basePath = null; headPath = null;
        continue;
      }
      if (!afterDiffGit) continue;
      if (line.startsWith("--- a/")) { basePath = line.slice(6).trim(); continue; }
      if (line.startsWith("+++ b/")) { headPath = line.slice(6).trim(); continue; }
      if (line.startsWith("@@")) afterDiffGit = false;
    }
    if (basePath !== null && headPath !== null) files.push(headPath);
    return files;
  }

  // Scan a unified diff and extract stable HTML selector signals from `+` lines.
  // Uses changedLines for file/line truth and re-walks the raw diff for content.
  //
  // TWO-PASS design (ported verbatim from src/qa/changed-elements.ts):
  //   Pass 1 — changedLines builds the authoritative file→lineSet map.
  //   Pass 2 — an independent second walk over the raw diff lines extracts HTML selector signals
  //             from `+` content, tracking file + line number with the same advance rules as Pass 1.
  // The two-pass design is intentional: Pass 1 owns line-number truth; Pass 2 owns content
  // extraction. They advance in lock-step, so file/line are identical to what changedLines
  // produces — the implementation note in src/qa/changed-elements.ts explains this explicitly.
  // Do NOT collapse to a single pass; that would silently diverge line numbering across hunks
  // and interleaved deletions.
  changedElements(diff: string): ChangedElement[] {
    if (!diff) return [];

    // Step 1: use changedLines to build the authoritative file→lineSet map.
    const hunkLines = this.changedLines(diff);
    if (hunkLines.size === 0) return [];

    const results: ChangedElement[] = [];

    // Step 2: second pass over raw diff lines to extract signals from `+` content.
    // We track file and line number in parallel with changedLines' logic,
    // to correctly associate each `+` line with its file and line number.
    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;

    for (const raw of diff.split("\n")) {
      if (results.length >= MAX_ELEMENTS) break;

      if (raw.startsWith("diff --git")) {
        file = null;
        inHunk = false;
        continue;
      }

      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }

      if (!inHunk) {
        if (raw.startsWith("+++ ")) {
          const p = raw.slice(4).trim();
          file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
        }
        continue;
      }

      if (file === null) continue;

      const c = raw[0];
      if (c === "+") {
        const content = raw.slice(1); // strip the leading `+`
        const trimmed = content.trim();
        const lineNum = newLine;
        newLine++;

        // Only process lines that look like HTML/template content.
        // Skip lines with no `<` and no obvious HTML signal (avoids TS-only lines).
        if (trimmed.length === 0) continue;

        // Extract signals from this added line.
        const el = extractSignalsFromLine(trimmed, file, lineNum);
        if (el) results.push(el);

      } else if (c === "-") {
        // old side — does not advance new-file counter, and we skip deletions
      } else if (c === "\\") {
        // "\ No newline at end of file"
      } else {
        // context line
        newLine++;
      }
    }

    return results;
  }

  // MANUAL mode: tokenize guidance into noun-phrases (quoted spans kept whole; standalone tokens
  // must be ≥5 chars or a proper noun AND not a QA stopword). Returns ChangedElement{ text } only.
  changedElementsFromGuidance(guidance: string): ChangedElement[] {
    if (!guidance.trim()) return [];

    const phrases: string[] = [];

    // Step 1: extract quoted spans first (e.g. "contact form") — kept whole, not filtered
    const withoutQuotes = guidance.replace(/"([^"]+)"/g, (_m, p: string) => {
      phrases.push(p.trim());
      return " ";
    });

    // Step 2: tokenize remaining words; keep non-stopword tokens ≥5 chars OR proper nouns (uppercase start)
    const words = withoutQuotes.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-zA-Z0-9-]/g, "").trim();
      if (!cleaned) continue;
      const isProperNoun = /^[A-Z]/.test(cleaned);
      const isLongEnough = cleaned.length >= 5;
      const isStopword = GUIDANCE_STOPWORDS.has(cleaned.toLowerCase());
      if (isStopword) continue; // stopwords are never emitted, even if they're uppercase
      if (isLongEnough || isProperNoun) {
        phrases.push(cleaned);
      }
    }

    // Dedupe while preserving order
    const seen = new Set<string>();
    const unique = phrases.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

    return unique.map((phrase) => ({
      file: "",
      line: 0,
      text: phrase,
      raw: phrase,
    }));
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

// Maximum number of entries to return; mirrors change-coverage's MAX_ITEMS spirit.
const MAX_ELEMENTS = 200;

// ── Tag → ARIA role map ──────────────────────────────────────────────────────

const TAG_TO_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  label: "label",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
};

// Best-effort tag→role for opening tag strings.
function tagRole(tag: string): string | undefined {
  return TAG_TO_ROLE[tag.toLowerCase()];
}

// ── Visible-text tags (emit text only for these) ─────────────────────────────

const VISIBLE_TEXT_TAGS = new Set(["button", "a", "h1", "h2", "h3", "h4", "h5", "h6", "label"]);
// Also accept mat-* prefixed tags (Angular Material).
function isVisibleTextTag(tag: string): boolean {
  const low = tag.toLowerCase();
  return VISIBLE_TEXT_TAGS.has(low) || low.startsWith("mat-");
}

// ── Extraction helpers ───────────────────────────────────────────────────────

// Returns the opening tag name from the raw line, or null if none found.
function extractOpeningTag(line: string): string | null {
  const m = /<([a-zA-Z][a-zA-Z0-9-]*)/.exec(line);
  return m ? m[1]!.toLowerCase() : null;
}

// Extract a static attribute value from a raw line.
// Matches: attr="value" or attr='value'
function extractAttr(line: string, attr: string): string | undefined {
  const re = new RegExp(`\\b${attr}=["']([^"']+)["']`);
  const m = re.exec(line);
  return m ? m[1]! : undefined;
}

// Extract the literal value from [routerLink]="'/path'" or [routerLink]="'/path'" (with optional outer double-quotes).
// Must be a string LITERAL (single-quoted inside double-quotes). Dynamic expressions → undefined.
function extractBoundRouterLink(line: string): string | undefined {
  // Pattern: [routerLink]="'/...'" — the value is a single-quoted string literal
  const m = /\[routerLink\]=["']'([^'"]+)'["']/.exec(line);
  return m ? m[1]! : undefined;
}

// Extract visible inner text from a tag like <button>Text</button> or <h1>Text</h1>.
// Returns undefined when the text contains Angular interpolation or template literals.
function extractInnerText(line: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/(?:${tag}|)`, "i");
  const m = re.exec(line);
  if (!m) return undefined;
  const text = m[1]!.trim();
  if (!text) return undefined;
  // Skip interpolation / template literals
  if (text.includes("{{") || text.includes("${")) return undefined;
  return text;
}

// Extract visible inner text for mat-* tags (self-closing tag name part may vary).
function extractMatInnerText(line: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, "i");
  const m = re.exec(line);
  if (!m) return undefined;
  const text = m[1]!.trim();
  if (!text || text.includes("{{") || text.includes("${")) return undefined;
  return text;
}

// Extract a single ChangedElement from one added line (all signals merged).
// Returns null when no signal is found on this line.
function extractSignalsFromLine(
  line: string,
  file: string,
  lineNum: number,
): ChangedElement | null {
  // Only lines that contain < or HTML-like attrs are interesting.
  // This avoids false positives on pure TS lines.
  const hasHtmlSignal =
    line.includes("<") ||
    /\b(?:data-cy|data-testid|data-test|id=|name=|href=|routerLink|formControlName)=/.test(line);

  if (!hasHtmlSignal) return null;

  const el: Partial<ChangedElement> & { file: string; line: number; raw: string } = {
    file,
    line: lineNum,
    raw: line,
  };
  let hasSignal = false;

  // Stable attrs: data-cy | data-testid | data-test → testId
  const testId = extractAttr(line, "data-cy") ?? extractAttr(line, "data-testid") ?? extractAttr(line, "data-test");
  if (testId) {
    el.testId = testId;
    hasSignal = true;
  }

  // id="" → id
  const idVal = extractAttr(line, "id");
  if (idVal) {
    el.id = idVal;
    hasSignal = true;
  }

  // name="" or formControlName="" → name
  const nameVal = extractAttr(line, "name") ?? extractAttr(line, "formControlName");
  if (nameVal) {
    el.name = nameVal;
    hasSignal = true;
  }

  // href="/path" → href (relative only)
  const hrefVal = extractAttr(line, "href");
  if (hrefVal && (hrefVal.startsWith("/") || hrefVal.startsWith("#"))) {
    el.href = hrefVal;
    hasSignal = true;
  }

  // routerLink="/path" (unbound, static) → href
  // Only store when the value is an absolute path (starts with / or #) — the same filter
  // the href extractor applies. A bare relative value like routerLink="products" is ambiguous
  // (the DOM href renders as "/products") and would never join with a DOM attr; skip it.
  if (!el.href) {
    const routerLinkRe = /\brouterLink=["']([^"']+)["']/.exec(line);
    if (routerLinkRe) {
      const val = routerLinkRe[1]!;
      if (val.startsWith("/") || val.startsWith("#")) {
        el.href = val;
        hasSignal = true;
      }
    }
  }

  // [routerLink]="'/path'" → href (literal only; dynamic expr skipped)
  if (!el.href) {
    const bound = extractBoundRouterLink(line);
    if (bound !== undefined) {
      el.href = bound;
      hasSignal = true;
    }
  }

  // [routerLink]="expr" (non-literal) — already handled by returning nothing above for bound case.

  // Visible text in button/a/h1-6/label/mat-* elements
  const tag = extractOpeningTag(line);
  if (tag && !el.text) {
    el.role = tagRole(tag);
    if (isVisibleTextTag(tag)) {
      const visibleText = tag.startsWith("mat-")
        ? extractMatInnerText(line, tag)
        : extractInnerText(line, tag);
      if (visibleText) {
        el.text = visibleText;
        hasSignal = true;
      }
    }
  }

  if (!hasSignal) return null;
  return el as ChangedElement;
}

// ── Manual mode stopwords ────────────────────────────────────────────────────

// QA/structural stopwords: common verbs, nouns, and connectives that are so
// generic they only produce false-positive text-fallback matches in buildChangedMarker.
// Words like "test" (matches "test-submission"), "form" (too broad when used alone),
// "button", "link", "page", etc. are filtered from standalone tokens.
// Quoted multi-word phrases (e.g. "contact form") are NOT filtered — they carry
// enough specificity even if individual words are stopwords.
const GUIDANCE_STOPWORDS = new Set([
  "test", "tests", "form", "forms", "page", "pages",
  "button", "buttons", "link", "links",
  "click", "check", "verify", "ensure", "should",
  "with", "flow", "screen", "field", "fields",
  "input", "submit", "smoke", "the", "and",
]);

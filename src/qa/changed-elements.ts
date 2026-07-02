// Deterministic extraction of change-anchoring signals from a unified diff.
//
// `extractChangedElements` scans `+` lines (additions only) for stable HTML selector
// signals — data-cy/testid/id/name/href/routerLink/visible text — and returns a typed
// array of `ChangedElement`. Reuses `parseDiffHunks` from diff-hunks.ts for
// file/line truth (no re-implementation of diff parsing); signals are extracted in a
// second pass over the same lines.
//
// `changedElementsFromGuidance` handles MANUAL mode: tokenizes the guidance string into
// noun-phrases and returns ChangedElement{ text } entries for fuzzy DOM-name matching.
//
// Both functions are PURE (no I/O, no LLM call). Cap: 200 entries per `extractChangedElements`.
// A miss degrades to no-marker (never blocks, never alters nodes[]/attrs[]).

import { parseDiffHunks } from "./diff-hunks";

// ── Public interface ─────────────────────────────────────────────────────────

export interface ChangedElement {
  file: string;       // repo-relative, from parseDiffHunks key
  line: number;       // 1-based new-side line the signal was found on
  testId?: string;    // data-cy / data-testid / data-test value
  id?: string;        // id="" value
  name?: string;      // name="" / formControlName value
  text?: string;      // added visible text (button/link/heading/label inner text)
  href?: string;      // resolved PATH: href OR routerLink→href (store the path, NOT the framework attr)
  role?: string;      // best-effort tag→role (a→link, button→button, h1-6→heading, input→textbox)
  raw: string;        // trimmed added line (debug/telemetry)
}

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

// ── Main extractor ───────────────────────────────────────────────────────────

// Scan a unified diff and extract stable HTML selector signals from `+` lines.
// Uses parseDiffHunks for file/line truth and re-walks the raw diff for content.
export function extractChangedElements(diff: string): ChangedElement[] {
  if (!diff) return [];

  // Step 1: use parseDiffHunks to build the authoritative file→lineSet map.
  const hunkLines = parseDiffHunks(diff);
  if (hunkLines.size === 0) return [];

  const results: ChangedElement[] = [];

  // Step 2: second pass over raw diff lines to extract signals from `+` content.
  // We track file and line number in parallel with parseDiffHunks' logic,
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

// ── Manual mode: guidance noun-phrase extraction ─────────────────────────────

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

// Tokenize guidance into noun-phrases: quoted spans + capitalized/≥5-char non-stopword words.
// Returns ChangedElement{ text } per phrase. No file/line (not from a diff).
//
// Conservative-by-design: prefer UNDER-marking over false-positive markers.
// Rule: a standalone token is emitted only when ALL of the following hold:
//   1. It is ≥5 characters (raised from 4 to prevent short QA tokens like "test", "form").
//   2. It is NOT in GUIDANCE_STOPWORDS.
//   3. OR it starts with an uppercase letter (a proper noun signal that survives both checks).
// Quoted multi-word phrases bypass both the length and stopword filters — they are specific
// enough by construction.
export function changedElementsFromGuidance(guidance: string): ChangedElement[] {
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

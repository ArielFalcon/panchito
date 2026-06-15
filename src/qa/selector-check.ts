// Lever 2: deterministic selector verification against a captured aria snapshot.
// Pure module — no pipeline deps, no browser, no FS I/O. All exports are standalone
// functions that can be called with any parsed snapshot string[].
//
// How it fits in the pipeline: after a fix-loop round, the orchestrator extracts the
// proposed selectors from the generated specs (extractProposedSelectors), then checks
// each against the failure-point aria snapshot (selectorPresent / selectorUnique).
//   - present + unique   → ok (selector is valid and unambiguous)
//   - present + non-unique → ambiguity surface (strict-mode risk)
//   - absent             → UNVERIFIABLE (never a hard block — the snapshot may prune)
// This verdict feeds the progress gate (progress-gate.ts) and the next regeneration
// prompt (the contradiction is folded in as a GROUND TRUTH correction).

// A proposed selector extracted from a spec source file. `kind` identifies which
// Playwright locator family the call belongs to; `role` is the explicit ARIA role for
// getByRole calls; `name` is the accessible name (quoted literal or regex source);
// `exact` mirrors the `{ exact: true }` option; `isRegex` when the name was a `/…/` literal.
export interface ProposedSelector {
  kind: "role" | "text" | "label";
  role?: string;
  name?: string;
  exact?: boolean;
  isRegex?: boolean;
}

// The accessible name a structural role carries when parseAriaSnapshot could only confirm its
// PRESENCE, not its composed name (e.g. a `row` whose name was dropped → `row: (present)`).
// dom-snapshot.ts emits exactly this literal; selectorPresent must NOT treat it as a real name.
const STRUCTURAL_PRESENT_MARKER = "(present)";

// Result of selectorPresent. `present: false` may be either "definitely absent" or
// "snapshot may have pruned it" — both cases are UNVERIFIABLE and MUST NOT hard-block
// (Decision D4: the snapshot prunes hidden nodes; the executor is the final oracle).
export interface PresenceResult {
  present: boolean;
  // True when the check was conclusive (the role is known to the snapshot WITH a real name). False
  // when the role/name combination might be absent purely due to snapshot pruning OR because the
  // role appeared only as a `(present)` structural marker (its name was dropped) — treat as
  // advisory, never as an invalid spec.
  verifiable: boolean;
}

// Normalizes an accessible-name string: collapses whitespace runs ([\r\n\t\f\s]+) to a
// single space and trims leading/trailing whitespace. Applied to BOTH the expected name
// (from the selector) and the actual name (from the snapshot) before comparison so
// multi-line / tab-separated names from the YAML still match the author's intent.
export function normalizeName(s: string): string {
  return s.replace(/[\r\n\t\f\s]+/g, " ").trim();
}

// A snapshot "role: name" line parsed into its two parts. Returns null if the line
// does not have the expected shape.
function parseLine(line: string): { role: string; name: string } | null {
  const colon = line.indexOf(": ");
  if (colon === -1) {
    // A line of exactly "role: (present)" shape — colon exists but with value "(present)".
    const colon2 = line.indexOf(":");
    if (colon2 === -1) return null;
    return { role: line.slice(0, colon2).trim().toLowerCase(), name: line.slice(colon2 + 1).trim() };
  }
  return { role: line.slice(0, colon).trim().toLowerCase(), name: line.slice(colon + 2).trim() };
}

// Maps a `kind` to the set of ARIA roles it may match against. "role" uses the
// explicit role from the selector. "text" and "label" match against text/content
// nodes and labelled input roles respectively.
const TEXT_KIND_ROLES = new Set(["text", "heading", "listitem", "cell", "gridcell"]);
const LABEL_KIND_ROLES = new Set(["textbox", "combobox", "checkbox", "radio"]);

// Whether a snapshot node's role satisfies the selector's kind/role requirement.
function roleMatches(sel: ProposedSelector, snapshotRole: string): boolean {
  const norm = snapshotRole.toLowerCase();
  if (sel.kind === "role") {
    // getByRole: exact case-insensitive token match.
    return norm === (sel.role ?? "").toLowerCase();
  }
  if (sel.kind === "text") {
    // getByText: matches text and common textual-content roles.
    return TEXT_KIND_ROLES.has(norm) || norm === "button" || norm === "link";
  }
  if (sel.kind === "label") {
    // getByLabel: matches labelled input roles.
    return LABEL_KIND_ROLES.has(norm);
  }
  return false;
}

// Whether a snapshot node's name satisfies the selector's name requirement.
// Implements the accname rule verbatim from the design:
//   - no name / undefined → role-only: any node of that role matches
//   - isRegex              → regex.test(normalize(actual)) — no lowercase, no substring
//   - exact: true          → normalize(actual) === normalize(expected) (case-sensitive, trimmed)
//   - default              → lowercase(normalize(actual)).includes(lowercase(normalize(expected)))
function nameMatches(sel: ProposedSelector, snapshotName: string): boolean {
  if (!sel.name) return true; // role-only: match any node of that role
  // W2: the `(present)` literal is a STRUCTURAL marker (parseAriaSnapshot saw the role but dropped its
  // composed name), NOT a real accessible name. A name-bearing selector must NEVER match it — otherwise
  // a default ci-substring like name:"Present" (or "res"/"sent"/"ent") would substring-match "(present)"
  // → a spurious present:true that suppresses a real absent-contradiction and can fake uniqueness
  // (defeating the W3 real-bug guard). Short-circuit to NO MATCH (the marker has no real name to match).
  if (snapshotName === STRUCTURAL_PRESENT_MARKER) return false;
  const normActual = normalizeName(snapshotName);
  if (sel.isRegex) {
    // The name is a regex source string. Re-construct the RegExp.
    try {
      const re = new RegExp(sel.name);
      return re.test(normActual);
    } catch {
      return false; // invalid regex from spec → treat as no match (never throw)
    }
  }
  const normExpected = normalizeName(sel.name);
  if (sel.exact) {
    // Whole-string match, case-sensitive, but BOTH sides normalized (whitespace trimmed).
    return normActual === normExpected;
  }
  // Default: case-insensitive substring.
  return normActual.toLowerCase().includes(normExpected.toLowerCase());
}

// Checks whether a proposed selector matches at least one node in the snapshot.
//
// `treeLines` is the "role: name" string[] produced by parseAriaSnapshot — the SAME
// representation the agent was shown (required for soundness: the check must use
// IDENTICAL ground truth, not a re-parsed tree).
//
// Never throws. Returns `{ present: false, verifiable: false }` when the role is
// absent from the snapshot — this means the node MIGHT be there but was pruned
// (snapshot prunes hidden/uninteresting elements) — treat as UNVERIFIABLE, never invalid.
export function selectorPresent(sel: ProposedSelector, treeLines: string[]): PresenceResult {
  try {
    let anyRoleWithRealName = false; // role matched a node carrying a real (non-(present)) name
    for (const line of treeLines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (!roleMatches(sel, parsed.role)) continue;
      // W4: a `(present)` structural marker means parseAriaSnapshot saw the role but DROPPED its
      // composed name. A name-bearing selector cannot be judged absent against such a node — the
      // name might be there in reality. Only nodes with a REAL name make a name-mismatch conclusive.
      const isPresentMarker = parsed.name === STRUCTURAL_PRESENT_MARKER;
      if (!isPresentMarker) anyRoleWithRealName = true;
      if (nameMatches(sel, parsed.name)) {
        // A role-only selector (no name) legitimately matches a `(present)` marker (role exists →
        // present). A name-bearing selector never name-matches "(present)": nameMatches short-circuits
        // it to NO MATCH (W2), so a selector name that happens to substring "(present)" cannot fake it.
        return { present: true, verifiable: true };
      }
    }
    // Conclusive absence requires the role to have been seen WITH a real name (so the name
    // comparison was meaningful). Role absent entirely, OR present only as a `(present)` marker
    // with the name dropped → UNVERIFIABLE (may be pruned / name-dropped), never a contradiction.
    return { present: false, verifiable: anyRoleWithRealName };
  } catch {
    // Defensive: never let a bug in the matcher propagate to the pipeline.
    return { present: false, verifiable: false };
  }
}

// Returns true when EXACTLY ONE node in the snapshot satisfies the presence rule.
// Used to detect strict-mode ambiguity: multiple matching nodes → getByRole will throw
// in strict mode (e.g. two "Owner name" textboxes after a creation flow).
export function selectorUnique(sel: ProposedSelector, treeLines: string[]): boolean {
  let count = 0;
  for (const line of treeLines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (roleMatches(sel, parsed.role) && nameMatches(sel, parsed.name)) {
      count++;
      if (count > 1) return false; // short-circuit on second match
    }
  }
  return count === 1;
}

// Strips comments from a spec source and joins it into one space-separated string for regex matching.
// Three passes, in order:
//   1. drop FULL-LINE comments (lines whose first non-space char is `//` or a block-body `*`), so a
//      commented-out Prettier-WRAPPED call cannot survive as an orphan body and form a match;
//   2. strip INLINE `/* … */` block comments (non-greedy, dotall) — a `/* old: getByRole("Ghost") */`
//      on a live line must not leak "Ghost" as a real selector (W5);
//   3. strip TRAILING `// …` line comments — a `getByRole("Real"); // getByRole("Ghost")` tail must
//      not leak "Ghost" either (W5).
// Order matters: block comments are removed BEFORE the trailing-`//` strip so a `//` INSIDE a `/* … */`
// (e.g. `/* see http://… */`) is not mistaken for a line comment. The result is the COMMENT-STRIPPED
// source on one line — a call wrapped across lines is matched as a whole, tokens stay space-separated.
function stripCommentsAndJoin(specSrc: string): string {
  const lines = specSrc
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*"));
    })
    .join(" ");
  // Remove /* … */ block comments first (non-greedy, dotall), then trailing // … line comments.
  return lines.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// Extracts all proposed selectors from a spec source file using regex over the call
// sites. Pure — no parsing, no AST. Only the three locator families the agent uses are
// captured; other locator types are ignored (not relevant to the Lever-2 check).
//
// W2: matched over a COMMENT-STRIPPED, line-JOINED source (not per line), so a Prettier-wrapped
// call — `getByRole("button", {\n  name: "Add Owner",\n})` — is captured instead of silently
// skipped (a per-line scan never saw the whole call → Lever-2 missed real selectors and could
// misfire the real-bug branch). Full-line comments, inline `/* … */` blocks, and trailing `// …`
// comments are all dropped first (stripCommentsAndJoin, W5) so no commented-out call is captured.
//
// Captured families:
//   getByRole("role"[, { name: "str"|/regex/[, exact: true] }])
//   getByText("str"[, { exact: true }])
//   getByLabel("str"[, { exact: true }])
export function extractProposedSelectors(specSrc: string): ProposedSelector[] {
  const joined = stripCommentsAndJoin(specSrc);

  // Collect each family's matches WITH their source index, then emit in source order (the old
  // per-line scan preserved source order; grouping by family would reorder mixed specs).
  // The option object `{ … }` may span lines (now joined): `[\s\S]*?` (lazy, dotall) lets the body
  // include the spaces from joining and stops at the first closing brace (each call is independent).
  const found: Array<{ index: number; sel: ProposedSelector }> = [];

  const roleRe = /\.getByRole\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(joined)) !== null) {
    const role = m[1]!.trim();
    const { name, exact, isRegex } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "role", role, ...(name !== undefined ? { name } : {}), ...(exact ? { exact } : {}), ...(isRegex ? { isRegex } : {}) } });
  }

  const textRe = /\.getByText\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = textRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "text", name, ...(exact ? { exact } : {}) } });
  }

  const labelRe = /\.getByLabel\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = labelRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "label", name, ...(exact ? { exact } : {}) } });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.sel);
}

// Locator families Lever-2 CANNOT extract/verify against an aria snapshot: getByTestId (test ids
// are not in the a11y tree), raw CSS/XPath `.locator(…)`, getByPlaceholder/getByAltText/getByTitle
// (names parseAriaSnapshot does not surface), AND the REGEX-first-arg forms `getByText(/…/)` /
// `getByLabel(/…/)` — extractProposedSelectors only captures STRING-literal first args, so a regex
// name slips past extraction entirely (W4). Their PRESENCE in a spec makes the "every selector is
// present+unique" judgment INCOMPLETE — a decorative extractable getByRole could look unique while
// the ACTUAL failing locator is one of these. The real-bug branch (pipeline.ts) must then treat
// uniqueness as indeterminate and NOT fire a false "app defect" Issue (W5).
// `getByText\(\s*/` / `getByLabel\(\s*/` only match when the FIRST arg is a regex literal (the `/`
// immediately after the paren); a string-literal `getByText("…")` is still extracted, not caught here.
const NON_EXTRACTABLE_LOCATOR_RE = /\.(?:getByTestId|locator|getByPlaceholder|getByAltText|getByTitle)\s*\(|\.(?:getByText|getByLabel)\s*\(\s*\//;

// True when the spec uses ANY locator family Lever-2 cannot extract/verify (see above). Comment-
// stripped the same way extractProposedSelectors is (full-line, inline /* … */, and trailing // …),
// so a commented-out call — wrapped, inline, or trailing — does not count.
export function hasNonExtractableLocator(specSrc: string): boolean {
  return NON_EXTRACTABLE_LOCATOR_RE.test(stripCommentsAndJoin(specSrc));
}

// Parses the option string from a locator call (the `{ name: …, exact: … }` part).
// Returns the name (string or regex source), exact flag, and isRegex flag.
// Handles: `name: "str"`, `name: /regex/flags`, `exact: true`.
function extractNameOpts(opts: string): { name?: string; exact?: boolean; isRegex?: boolean } {
  if (!opts.trim()) return {};

  // Match name: /regex/ or name: /regex/flags
  const regexNameMatch = /\bname\s*:\s*\/([^/]+)\/[a-z]*/i.exec(opts);
  if (regexNameMatch) {
    return { name: regexNameMatch[1]!, isRegex: true };
  }

  // Match name: "str" or name: 'str' or name: `str`
  const strNameMatch = /\bname\s*:\s*["'`]([^"'`]*)["'`]/.exec(opts);
  const name = strNameMatch ? strNameMatch[1]! : undefined;

  // Match exact: true
  const exactMatch = /\bexact\s*:\s*true\b/.test(opts);

  return { ...(name !== undefined ? { name } : {}), ...(exactMatch ? { exact: true } : {}) };
}

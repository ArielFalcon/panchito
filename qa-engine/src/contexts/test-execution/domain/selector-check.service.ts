// Pure selector-vs-DOM gate, lifted from src/qa/selector-check.ts. The service is a thin class
// delegate over checkSpecSelectors(specSources, trees, treeLabel?) → SpecSelectorFindings AND
// unscopedMultipleContradictions(specSources, trees, treeLabel?) → string[].
// Both public functions are copied verbatim (parity-pinned); NO behavioral change.
// SpecSelectorFindings fields: contradictions, absentKeys, anyVerifiedPresent,
// anyNonExtractable, anyUnverifiable.

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
// Task 3.1 (Slice 3): strip any trailing ARIA state token suffix BEFORE splitting — nodes[] lines
// may carry known ARIA state suffixes (seam A) when passed through from the capture; role and name
// extraction must be unaffected. The strip is additive insurance: parseAriaSnapshot keeps nodes[]
// bare, but this makes parseLine robust if a known-state suffix ever arrives.
//
// ALLOWLIST — strips ONLY known ARIA interactive-state tokens:
//   disabled, expanded, checked, required, selected, pressed, level=<digits>
// Multiple trailing tokens are supported (e.g. "Email [required] [disabled]").
// Arbitrary bracket content — badge counts "Inbox [5]", draft markers "Edit [Draft]",
// status markers "Deploy [Beta]" — is NEVER stripped so real accessible names survive intact.
// The pattern does NOT match [CHANGED: …] markers (not a state token), restoring Slice 1's
// fail-safe: a leaked [CHANGED:] suffix is preserved, not silently erased.
const ARIA_STATE_STRIP_RE = /(?:\s*\[(disabled|expanded|checked|required|selected|pressed|level=\d+)\])+\s*$/;

function parseLine(line: string): { role: string; name: string } | null {
  // Strip trailing ARIA state token suffix (allowlist only) before any other processing
  const clean = line.replace(ARIA_STATE_STRIP_RE, "").trim();
  const colon = clean.indexOf(": ");
  if (colon === -1) {
    // A line of exactly "role: (present)" shape — colon exists but with value "(present)".
    const colon2 = clean.indexOf(":");
    if (colon2 === -1) return null;
    return { role: clean.slice(0, colon2).trim().toLowerCase(), name: clean.slice(colon2 + 1).trim() };
  }
  return { role: clean.slice(0, colon).trim().toLowerCase(), name: clean.slice(colon + 2).trim() };
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

// A non-extractable scope prefix immediately followed (on the same call chain) by an extractable
// selector: e.g. `.locator('.x').getByRole(...)`, `.getByTestId('x').getByRole(...)`.
// A1 safe-direction (per-selector). A "MULTIPLE" ambiguity is surfaced pre-execution ONLY for a
// selector we can PROVE is unscoped — rooted directly on the `page` fixture (`page.getByRole(…)` /
// `this.page.getByRole(…)`). Any other rooting narrows the tree in a way the full-tree check cannot
// see — a `.locator(…)` chain OR a locator held in a variable (`const row = page.getByTestId(…);
// row.getByRole(…)`) — so its uniqueness is INDETERMINATE and a "MULTIPLE" there would be a FALSE
// positive that could wrongly hold a good spec `invalid` at W2. We SUPPRESS by default and surface
// only the page-rooted case: the same conservative guarantee the old blanket
// `if (anyNonExtractable) return []` gave, now applied PER-SELECTOR instead of per-spec (so a
// standalone terminal `getByTestId('x')` no longer silences an unrelated page-rooted getByRole).
//
// `before` is the comment-stripped joined source up to the selector's `.getByXxx(` (the exact index
// extractProposedSelectorsWithIndex returns), so the check is alignment-safe. stripCommentsAndJoin
// joins lines with spaces, hence the trailing-whitespace trim and the optional `\s*` around `this.`.
const PAGE_ROOT_BEFORE_RE = /(?:^|[^.\w$])(?:this\s*\.\s*)?page$/;
function isPageRootedAt(joined: string, index: number): boolean {
  return PAGE_ROOT_BEFORE_RE.test(joined.slice(0, index).replace(/\s+$/, ""));
}

// Returns MULTIPLE-node ambiguity contradictions ONLY for extractable selectors that are PROVABLY
// unscoped (page-rooted). This is the per-selector replacement for the blanket
// `if (findings.anyNonExtractable) return []` the consumer (ambiguousSelectorsNow) used to apply.
//
// Only returns contradictions that include "MULTIPLE" (pre-execution ambiguity check). Absent and
// unverifiable contradictions are unchanged — they are not affected here.
//
// HOW IT WORKS:
//   1. Run checkSpecSelectors normally → all MULTIPLE contradictions (computed over the FULL tree,
//      which cannot see locator/variable scoping).
//   2. Fast path: no non-extractable locator anywhere → no scoping is possible → return MULTIPLE as-is.
//   3. Otherwise re-extract extractable selectors WITH their source index and keep a MULTIPLE
//      contradiction ONLY when that selector is page-rooted (isPageRootedAt). Locator-chained and
//      variable-scoped selectors are SUPPRESSED as indeterminate (safe direction — never a false block).
//
// INVARIANT: anyNonExtractable is still computed and returned unchanged. The W5 real-bug branch
// (pipeline.ts allUnique) must still hold false when any non-extractable locator is present.
// This function only changes WHICH contradictions reach the pre-execution corrective regen path.
export function unscopedMultipleContradictions(
  specSources: string[],
  trees: string[][],
  treeLabel = "pre-write",
): string[] {
  const findings = checkSpecSelectors(specSources, trees, treeLabel);
  // Fast path: no non-extractable locators → no scope suppression possible; return MULTIPLE as-is.
  if (!findings.anyNonExtractable) {
    return findings.contradictions.filter((c) => c.includes("MULTIPLE"));
  }
  // There IS at least one non-extractable locator somewhere → check each extractable selector's
  // rooting and surface only the provably-unscoped (page-rooted) ones.
  const unsuppressed: string[] = [];
  for (const specSrc of specSources) {
    const joined = stripCommentsAndJoin(specSrc);
    // Re-extract with indices so we can map contradictions to their source position.
    const extractedWithIndex = extractProposedSelectorsWithIndex(joined);
    for (const { index, sel } of extractedWithIndex) {
      // Surface a MULTIPLE only for a selector PROVABLY unscoped (page-rooted). A locator chain or a
      // variable-held locator narrows the tree invisibly → indeterminate → suppress (safe direction).
      if (!isPageRootedAt(joined, index)) continue;
      // Page-rooted → check if it produces a MULTIPLE contradiction in findings.
      // Match by reconstructing the role label and name label used in contradiction messages.
      const roleLabel = sel.role ?? sel.kind;
      const nameLabel = sel.name ? ` "${sel.name}"` : "";
      const contradictionPrefix = `${roleLabel}:${nameLabel} matches MULTIPLE`;
      if (findings.contradictions.some((c) => c.startsWith(contradictionPrefix))) {
        unsuppressed.push(findings.contradictions.find((c) => c.startsWith(contradictionPrefix))!);
      }
    }
  }
  // Deduplicate: the same contradiction may appear from multiple spec sources.
  return [...new Set(unsuppressed)];
}

// Variant of extractProposedSelectors that also returns the character index of each selector's
// `.getByRole(` / `.getByText(` / `.getByLabel(` call in the comment-stripped joined source.
// Internal — used only by unscopedMultipleContradictions to correlate with scopedExtractableIndices.
function extractProposedSelectorsWithIndex(joined: string): Array<{ index: number; sel: ProposedSelector }> {
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

  return found.sort((a, b) => a.index - b.index);
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

// Stable STRUCTURED identity for a proposed selector: role+name+exact+isRegex+kind. Used to
// compare an absent selector across rounds by identity — NOT by startsWith over the human-readable
// contradiction strings, which mis-counts an absent→ambiguous transition (the same selector, now
// MULTIPLE instead of absent) as "still absent".
export function selectorKey(sel: ProposedSelector): string {
  return `${sel.kind}|${sel.role ?? ""}|${sel.name ?? ""}|${sel.exact ? "1" : "0"}|${sel.isRegex ? "1" : "0"}`;
}

// The structured findings of checking a spec's extractable selectors against a set of a11y trees.
export interface SpecSelectorFindings {
  // Human-readable MULTIPLE-nodes / NOT-in-tree messages, ready to fold into a regen prompt.
  contradictions: string[];
  // Structured identities of verifiable-absent selectors (for cross-round progress comparison).
  absentKeys: Set<string>;
  // At least one extracted selector resolved to ≥1 node in some tree.
  anyVerifiedPresent: boolean;
  // The spec uses a locator family Lever-2 cannot extract (.locator/getByTestId/…) — uniqueness
  // is then INDETERMINATE (the visible getByRole set is not the full locator set).
  anyNonExtractable: boolean;
  // At least one extracted selector was neither present nor verifiable-absent in any tree (its
  // role never appeared with a real name) — uniqueness cannot be trusted.
  anyUnverifiable: boolean;
}

// The reusable Lever-2 core. Checks every extractable selector in each spec source against the
// given a11y `trees` and returns the structured findings.
//
// AGNOSTIC TO THE TREE SOURCE: `trees` may be post-failure failureDom captures OR pre-write
// per-route grounding OR anything else — this function never knows or cares which app, framework,
// routing, or rendering produced them. Each tree is a `string[]` of `"role: name"` lines (the
// parseAriaSnapshot shape). PER-TREE, NEVER FUSED: a selector is non-unique only when it resolves
// to >1 nodes within a SINGLE tree (a real strict-mode trigger), and absent only when absent in
// EVERY tree (so a node present on page A is never judged "absent" against page B). Pure; never
// throws; empty `trees` yields empty findings (best-effort, safe no-op).
//
// `treeLabel` only names the tree in the absent message ("…NOT in the captured <label> tree");
// it defaults to the post-failure wording for byte-identical behavior at the existing call site.
export function checkSpecSelectors(
  specSources: string[],
  trees: string[][],
  treeLabel = "failure-point",
): SpecSelectorFindings {
  const contradictions: string[] = [];
  const absentKeys = new Set<string>();
  let anyVerifiedPresent = false;
  let anyNonExtractable = false;
  let anyUnverifiable = false;

  for (const specSrc of specSources) {
    if (hasNonExtractableLocator(specSrc)) anyNonExtractable = true;
    for (const sel of extractProposedSelectors(specSrc)) {
      const presences = trees.map((t) => selectorPresent(sel, t));
      const anyPresent = presences.some((p) => p.present);
      const anyVerifiable = presences.some((p) => p.verifiable);
      if (anyPresent) {
        anyVerifiedPresent = true;
        // Non-unique within ANY single tree → strict-mode risk (per-tree, never fused). Reuse the
        // already-computed `presences` (selectorPresent is pure) — only the uniqueness count is new.
        if (presences.some((p, i) => p.present && !selectorUnique(sel, trees[i]!))) {
          const roleLabel = sel.role ?? sel.kind;
          const nameLabel = sel.name ? ` "${sel.name}"` : "";
          contradictions.push(`${roleLabel}:${nameLabel} matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)`);
        }
      } else if (anyVerifiable) {
        // Verifiable-absent in EVERY tree (role known to ≥1 tree with a real name, no name match
        // anywhere) → a real contradiction. Unverifiable-everywhere is skipped below.
        absentKeys.add(selectorKey(sel));
        const roleLabel = sel.role ?? sel.kind;
        const nameLabel = sel.name ? ` "${sel.name}"` : "";
        const presentRoles = [...new Set(trees.flatMap((t) => t.map((l) => l.split(":")[0]?.trim())).filter(Boolean))].join(", ");
        contradictions.push(
          `${roleLabel}:${nameLabel} is NOT in the captured ${treeLabel} tree. Present roles: ${presentRoles || "(none)"}`,
        );
      } else {
        // Neither present nor verifiable-absent in any tree → UNVERIFIABLE (role never appeared with
        // a real name). Not a contradiction (the snapshot may prune it), but uniqueness can't be trusted.
        anyUnverifiable = true;
      }
    }
  }
  return { contradictions, absentKeys, anyVerifiedPresent, anyNonExtractable, anyUnverifiable };
}

export class SelectorCheckService {
  // Delegates to the verbatim-copied checkSpecSelectors.
  // specSources: spec file text strings; trees: per-snapshot "role: name" line arrays.
  check(
    specSources: string[],
    trees: string[][],
    treeLabel = "failure-point",
  ): SpecSelectorFindings {
    return checkSpecSelectors(specSources, trees, treeLabel);
  }

  // Pre-execution MULTIPLE-ambiguity filter, page-rooted selectors only (the per-selector scope
  // suppression the user's audit added). pipeline.ts (ambiguousSelectorsNow) calls this with the
  // "pre-write" tree label; Plan 6 wiring needs the same seam, so the service exposes it too.
  unscopedMultiple(
    specSources: string[],
    trees: string[][],
    treeLabel = "pre-write",
  ): string[] {
    return unscopedMultipleContradictions(specSources, trees, treeLabel);
  }
}

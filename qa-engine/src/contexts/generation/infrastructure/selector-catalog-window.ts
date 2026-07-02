// qa-engine/src/contexts/generation/infrastructure/selector-catalog-window.ts
// PORT (verbatim) of src/qa/selector-check.ts's catalog-gate dependency surface —
// confidentWindowEnd + extractTestIdSelectorsWithIndex — the two functions catalog-gate.ts (Pillar
// 2 slice 4) needs from the Lever-2 selector-check module, plus their shared private
// stripCommentsAndJoin (string-aware comment strip).
//
// SCOPE + WHY A NEW FILE (not reused from either existing qa-engine selector-check copy):
// - qa-run-orchestration/domain/helpers/selector-check.ts already carries the checkSpecSelectors
//   core (verified byte-parity, comment-only diff) and its own header EXPLICITLY documents these two
//   functions as "addendum G2's SEPARATE, out-of-scope concern" — deliberately not ported there.
// - Reusing that file would require `generation` to import FROM `qa-run-orchestration/domain`, the
//   wrong hexagonal direction (qa-run-orchestration depends on generation as the role it coordinates,
//   never the reverse — see composition-root.ts / bridges/*.adapter.ts for the established direction).
// - stripCommentsAndJoin is a private (non-exported) module-scope function in every existing copy
//   (src/qa/selector-check.ts, both qa-engine copies) — it cannot be imported across files regardless
//   of context, so a self-contained port is the only option, matching the pattern src/qa/selector-check.ts
//   itself uses (confidentWindowEnd/extractTestIdSelectorsWithIndex call the file's OWN private copy).
//
// Placed alongside route-catalog.ts (same generation/infrastructure/ context) because catalog-gate.ts
// (Pillar 2 slice 4) is the sole consumer and lives in the same context.
//
// Pure module — no pipeline deps, no browser, no FS I/O.

// Cut a line at its first `//` that is OUTSIDE a string literal — a real trailing line comment. A `//`
// inside a '…', "…" or `…` string (a URL `https://`, a breadcrumb "a // b", a path "x//y") is NOT a
// comment and is preserved. Backslash escapes inside strings are honored. A char-scanner, because a
// regex cannot tell a comment `//` from a `//` inside a string.
function stripTrailingLineComment(line: string): string {
  let quote: string | null = null; // the open quote char, or null when outside any string
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; } // skip the escaped char inside a string
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return `${line.slice(0, i)} `; // real comment start (outside any string) → cut here
    }
  }
  return line;
}

// Strips comments from a spec source and joins it into one space-separated string for regex matching.
// Three passes, in order:
//   1. drop FULL-LINE comments (lines whose first non-space char is `//` or a block-body `*`), so a
//      commented-out Prettier-WRAPPED call cannot survive as an orphan body and form a match;
//   2. strip INLINE `/* … */` block comments (non-greedy, dotall) — a `/* old: getByTestId("Ghost") */`
//      on a live line must not leak "Ghost" as a real selector (W5);
//   3. strip TRAILING `// …` line comments — a `getByTestId("Real"); // getByTestId("Ghost")` tail must
//      not leak "Ghost" either (W5).
// Order matters: block comments are removed BEFORE the trailing-`//` strip so a `//` INSIDE a `/* … */`
// (e.g. `/* see http://… */`) is not mistaken for a line comment. The result is the COMMENT-STRIPPED
// source on one line — a call wrapped across lines is matched as a whole, tokens stay space-separated.
function stripCommentsAndJoin(specSrc: string): string {
  // Block comments FIRST, on the RAW multi-line source (dotall — a /* … */ may span lines, and a `//`
  // inside it must not be mistaken for a line comment). Each block collapses to a single space.
  const noBlocks = specSrc.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlocks
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*")); // full-line // or block-body *
    })
    // Strip a trailing `//` comment PER LINE (bounded to its own line so it can never swallow later
    // lines once joined) and ONLY when the `//` is outside a string literal (so a URL / breadcrumb /
    // path `//` inside a string is preserved, not mistaken for a comment).
    .map(stripTrailingLineComment)
    .join(" ");
}

// The lexical end of the catalog gate's "confident window": the index (in the comment-stripped joined
// source) of the first action that makes the INITIAL-route catalog stale — the first `.click()`/`.tap()`
// or the SECOND `.goto()`. A selector after this point may live on a page reached post-navigation, which
// the initial catalog cannot see, so the gate must NOT fail-close there (it would false-block).
// `fill`/`type`/`press`/`hover`/`check`/`selectOption` do NOT close the window (they don't navigate).
// The 2nd-goto rule is conservative: the design keeps the window open across `goto(<same route>)`, but
// closing on ANY second goto only NARROWS the window (fewer fail-closes, never a false block) — the safe
// direction. Returns Infinity when nothing closes it (the whole spec is the confident window).
export function confidentWindowEnd(specSrc: string): number {
  const joined = stripCommentsAndJoin(specSrc);
  const firstClick = joined.search(/\.(?:dblclick|click|tap)\s*\(/); // dblclick is a click variant that can navigate too
  const gotoRe = /\.goto\s*\(/g;
  let count = 0;
  let secondGoto = -1;
  for (let m: RegExpExecArray | null; (m = gotoRe.exec(joined)) !== null; ) {
    if (++count === 2) { secondGoto = m.index; break; }
  }
  const ends = [firstClick, secondGoto].filter((i) => i >= 0);
  return ends.length > 0 ? Math.min(...ends) : Infinity;
}

// getByTestId selectors WITH their position in the comment-stripped joined source, so the gate can tell
// which fall inside the confident window (index < confidentWindowEnd). Same comment-stripping as the
// aria extractor (W5 parity). Interpolated `${…}` values are dropped (computed → un-groundable). The
// index is in the SAME coordinate space as confidentWindowEnd (both strip the identical source).
export function extractTestIdSelectorsWithIndex(specSrc: string): Array<{ value: string; index: number }> {
  const joined = stripCommentsAndJoin(specSrc);
  const re = /\.getByTestId\(\s*["'`]([^"'`]+)["'`]/g;
  const out: Array<{ value: string; index: number }> = [];
  for (let m: RegExpExecArray | null; (m = re.exec(joined)) !== null; ) {
    const value = m[1]!.trim();
    if (value && !value.includes("${")) out.push({ value, index: m.index });
  }
  return out;
}

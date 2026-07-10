// Deterministic route-normalization + ARIA-snapshot parsing helpers, shared by the DOM-grounding
// callers still living in src/: src/integrations/opencode-client.ts (normalizeRoutes, MAX_ROUTES),
// src/qa/execute.ts (parseAriaSnapshot), and src/qa/selector-check.test.ts (extractTargetRoutes, a
// cross-file drift guard against firstGotoRoute's own route normalization).
//
// The full DOM-capture/render pipeline this file used to own (captureDom, captureDomByRoute,
// captureDomForRoutes, captureRouteTrees, formatDomSnapshot, mergeAttrs, normalizeKey, capDomLines,
// isPriorityNode, buildChangedMarker, parseAriaSnapshotWithState, defaultCaptureDomDeps, and the
// NodeAttr/RawAttr/RouteSnapshot/CaptureDomInput/CaptureDomDeps types) was superseded by qa-engine's
// generation/infrastructure/dom-snapshot.ts port. It is trimmed here as dead code — its last
// remaining caller, src/qa/context-pack.ts, was deleted in migration-remediation Slice 8.A2, and its
// route-catalog dependency (src/qa/route-catalog.ts) was deleted in Slice 8.E alongside this trim.

// Normalize an explicit route list the way capture used to: trim, drop ${…}-interpolated and
// absolute URLs (not a stable app route), and dedupe. Exported so callers key their per-route
// lookups identically to how routes were normalized during capture.
export function normalizeRoutes(routes: string[]): string[] {
  return [...new Set(routes.map((r) => r.trim()).filter((r) => r && !r.includes("${") && !/^https?:\/\//i.test(r)))];
}

export const MAX_ROUTES = 4; // a spec/objective rarely targets more; bound the render cost + the prompt size

// Extract the routes a spec navigates from its `page.goto(...)` calls. Deterministic (regex over
// the source) — the routes are literal strings in the spec. Relative paths only (an absolute URL
// to a third party is not part of the app under test). Deduped and bounded.
export function extractTargetRoutes(specContents: string[], max = MAX_ROUTES): string[] {
  const routes = new Set<string>();
  const re = /\.goto\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const src of specContents) {
    // Scan line-by-line so a `.goto(...)` inside a comment (a commented-out route — e.g. an
    // example or a disabled flow) is not captured and rendered as if it were a live route.
    for (const line of src.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // line / block-body comment
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const r = m[1]!.trim();
        // Keep app-relative routes (the baseURL is prepended at render time). Drop absolute URLs and
        // template literals carrying ${...} interpolation (not a stable, renderable route).
        if (r.includes("${") || /^https?:\/\//i.test(r)) continue;
        routes.add(r.startsWith("/") ? r : `/${r}`);
        if (routes.size >= max) return [...routes];
      }
    }
  }
  return [...routes];
}

// Parses the YAML string returned by `locator('body').ariaSnapshot()` (Playwright >=1.57) into
// "role: name" lines for the interactive/labelled nodes the reviewer cares about. Pure — exported
// for testing. Replaces the JSON-tree walk of `flattenAccessibilityTree` (removed in PW 1.57);
// the output contract ("role: name" lines) is IDENTICAL to what formatDomSnapshot (now qa-engine's
// generation/infrastructure/dom-snapshot.ts) expects.
//
// Grammar (verified against PW 1.60.0 in the spike — engram #559):
//   <indent>- <role>[ "<name>"][ [attr…]][: <inline value>]   (name node or content node)
//   <indent>- <role>:                                          (bare colon → children follow)
//   <indent>- /url: …                                         (directive → skip)
//
// Role = first token; name = double-quoted string (accessible name).
// For ANY kept role, a bare `: value` on the same line (no quoted name) IS the name (S2).
// State brackets [checked]/[disabled]/[selected]/[level=N] are parsed but not used as names.
// 2-space indent nesting: all levels emitted flat (depth is irrelevant here).
export function parseAriaSnapshot(yaml: string): string[] {
  const out: string[] = [];

  // Interactive/labelled roles the author cares about. CRUCIAL: this MUST include the TABLE/LIST
  // roles (columnheader, cell, listitem, …). They were missing, so a snapshot of a data table showed
  // the author NOTHING — and the generator kept writing `getByRole("columnheader")` blind, which
  // returns 0 on a Bootstrap table whose <th> is not exposed as a columnheader (the #1 observed
  // execution failure). Including `cell`/`gridcell` also SURFACES DUPLICATE text (e.g. "radiology" in
  // two vet rows), which is exactly what causes the strict-mode ambiguity failures — now visible so
  // the author scopes uniquely instead of matching N elements.
  const keep = new Set([
    "link", "button", "heading", "textbox", "combobox", "checkbox", "radio", "tab", "menuitem", "option",
    "columnheader", "rowheader", "cell", "gridcell", "listitem", "row", "table", "grid", "list",
    // "text" is NOT in the original flattenAccessibilityTree keep-set (it's a JSON-tree role that
    // did not appear there), but ariaSnapshot emits `- text: value` for presentation-table layouts
    // and inline textual content — keeping it surfaces the "collapsed table" case (Bootstrap) so the
    // author can see there is no columnheader and write accordingly.
    "text",
    // Seam B (Slice 3): expanded keep-set for landmarks, modals, forms, live-regions, and toggle widgets.
    // These were absent from grounding, making the reviewer blind to modal presence, form context, and
    // navigation structure. alert/status/progressbar are live-regions (name = the message); switch is a
    // valued toggle widget (name = its label). All kept; structural designation is per-role below.
    "dialog", "alertdialog", "alert", "status", "form", "navigation", "banner", "main", "switch", "progressbar",
  ]);
  // Roles whose mere PRESENCE is informative even WITHOUT an accessible name, so we emit a bare
  // "(present)" marker instead of dropping them:
  //  • landmarks (table/grid/list/row) — lets the author see "there is a table here" and reason about
  //    which roles it actually exposes (e.g. cells but no columnheader) vs assuming HTML-implied roles.
  //  • form inputs (textbox/combobox/checkbox/radio) — a form whose <label> is NOT associated (no
  //    for/id, common in apps like PetClinic) leaves the input UNNAMED; without this it is DROPPED and
  //    the whole form goes INVISIBLE to grounding, so the reviewer can't confirm the author's selectors
  //    and falsely REJECTS them. The marker says the field EXISTS → target it by attribute/position.
  //  • Seam B structural additions (Slice 3): dialog/alertdialog/form/navigation/banner/main — containers
  //    whose presence is informative even when unnamed. switch is structural too (Gate Delta 4: toggle
  //    symmetry with checkbox/radio). alert/status/progressbar are NOT structural — their name IS the
  //    live message; an unnamed live-region carries no information worth surfacing as a presence marker.
  const structural = new Set(["table", "grid", "list", "row", "textbox", "combobox", "checkbox", "radio",
    "dialog", "alertdialog", "form", "navigation", "banner", "main", "switch"]);

  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    // Must start with the list marker; blank lines and anything else are skipped.
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim(); // everything after "- "

    // Directive lines: /url: … /options: … etc. — skip entirely.
    if (rest.startsWith("/")) continue;

    // Extract role: first token (stops at space, `"`, `[`, or `:`).
    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    if (!keep.has(role)) continue;

    const afterRole = rest.slice(role.length); // everything after the role token

    // Attempt to extract quoted name: `"accessible name"` (first double-quoted segment). The body
    // allows backslash-escaped chars (`\\.`) so a name containing an escaped quote — e.g.
    // `- button "say \"hi\""` — is captured WHOLE (T1); `[^"]*` would truncate at the first `\"`.
    // The captured body is then unescaped (`\"`→`"`, `\\`→`\`) back to the real accessible name.
    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
      if (out[out.length - 1] === "") out.pop();
      continue;
    }

    // No quoted name. Check for bare `: value` (inline value) or a bare colon (children block).
    const colonIdx = afterRole.indexOf(":");
    if (colonIdx !== -1) {
      const afterColon = afterRole.slice(colonIdx + 1).trim();
      if (afterColon) {
        // S2: ANY kept role with a non-empty post-colon value and no quoted name → the value IS the
        // name. Previously only content roles (text/listitem/…) did this, so `- heading: Some Text`
        // (and any other non-content kept role with an inline value) was DROPPED entirely (→ []).
        // Strip trailing state brackets the value might carry (e.g. `heading: Foo [level=2]`).
        const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
        out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
        if (out[out.length - 1] === "") out.pop();
      } else if (structural.has(role)) {
        // Bare colon (children block) for a structural role → emit presence marker.
        out.push(`${role}: (present)`);
      }
      // else: a non-structural kept role with a bare colon (e.g. `- heading:` with no name) → skip
      // (no name to record, and a presence marker is not warranted for a non-structural role).
      continue;
    }

    // No colon at all — role token only (e.g. `- table` with trailing state only).
    // Strip state brackets and check if something remains.
    const strippedStates = afterRole.replace(/\s*\[[^\]]*\]/g, "").trim();
    if (!strippedStates && structural.has(role)) {
      out.push(`${role}: (present)`);
    }
  }

  return out;
}

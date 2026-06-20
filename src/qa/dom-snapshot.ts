// Deterministic DOM grounding for the independent reviewer. The reviewer judged UI facts (button
// labels, link text, routes) from its TRAINING memory of "similar apps" and hallucinated
// corrections (it claimed PetClinic's submit button says "Add Owner" when the live DOM says
// "Submit"), which burned regeneration rounds and poisoned the ledger with rules built on false
// facts. The fix: the ORCHESTRATOR (not the generator — independence holds) renders the routes the
// spec targets ONCE and captures the real roles + accessible names, which are inlined into the
// reviewer prompt so it grounds its UI claims in reality.
//
// The render reuses the watched repo's e2e Playwright project (the pinned version + the baked
// browsers) via a child process, the SAME pattern as src/qa/execute.ts — the orchestrator root has
// no Playwright of its own. The render is the deliberately-uncovered integration boundary; the
// route extraction and snapshot formatting (the deterministic core) are unit-tested.

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./code-runner";
import { killTree } from "./execute";

// One captured route: the accessible roles+names the reviewer judges UI facts against.
export interface RouteSnapshot {
  route: string;
  nodes?: string[]; // "role: name" lines (interactive/labelled elements only)
  error?: string; // capture failed for this route (degrade — never blocks review)
}

export interface CaptureDomInput {
  e2eDir: string; // the seeded e2e project (its node_modules has the pinned Playwright)
  baseUrl: string; // live DEV
  specContents: string[]; // the spec sources, to extract the routes they navigate
}

export interface CaptureDomDeps {
  // Renders each route against DEV and returns its accessible nodes. Injected so the deterministic
  // core is testable without a browser; defaultCaptureDomDeps spawns the e2e project's Playwright.
  render(e2eDir: string, baseUrl: string, routes: string[]): Promise<RouteSnapshot[]>;
}

export const MAX_ROUTES = 4; // a spec/objective rarely targets more; bound the render cost + the prompt size
const MAX_NODES_PER_ROUTE = 60; // keep the inlined snapshot compact
// Bound the TOTAL routes rendered across a whole fan-out plan (the union of every objective's routes).
// Kept low enough that the union render fits the scaled render budget below (12 × per-route ≈ the cap),
// so the render finishes rather than getting killed mid-flight (which would lose ALL routes). MAX_ROUTES
// still caps per objective. A truncated union is LOGGED (never silently dropped) — see captureDomByRoute.
const MAX_ROUTES_UNION = 12;

// Normalize an explicit route list the way capture does: trim, drop ${…}-interpolated and absolute
// URLs (not a stable app route), and dedupe. Exported so the fan-out keys its per-objective lookups
// IDENTICALLY to captureDomByRoute's map keys (a mismatch would silently lose grounding).
export function normalizeRoutes(routes: string[]): string[] {
  return [...new Set(routes.map((r) => r.trim()).filter((r) => r && !r.includes("${") && !/^https?:\/\//i.test(r)))];
}

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

// Roles whose PRESENCE is the most selector-critical and most easily lost to truncation: a data
// table/list usually sorts AFTER the nav/header/sidebar in document order, so a naive head-slice can
// drop every cell before reaching it — re-creating the exact "author sees nothing about the table"
// failure one layer down. These are kept past the cap so a present table/list always survives.
// `text` is here too (S1): a Bootstrap role="presentation" table COLLAPSES to `- text:` nodes with NO
// columnheader — that `text:` line IS the table-collapse signal parseAriaSnapshot surfaces, so the cap
// must not truncate it away (it sorts after the nav exactly like the real cells it stands in for).
const PRIORITY_ROLES = ["columnheader", "rowheader", "cell", "gridcell", "row", "table", "grid", "list", "listitem", "text"];
export const isPriorityNode = (line: string): boolean => PRIORITY_ROLES.some((r) => line.startsWith(`${r}:`));

// Caps a "role: name" line set to `max`, keeping EVERY priority (table/list) node and filling the
// remaining budget with the rest in document order — so a data table that sorts after the nav is
// never truncated away (the exact failure that made the author "see nothing about the table").
// Returns the kept lines plus how many were dropped, so a caller can note the omission. Exported
// for the fix-loop prompt (buildFailureDom), which caps the readable block, NOT the stored tree.
export function capDomLines(lines: string[], max: number): { kept: string[]; dropped: number } {
  if (lines.length <= max) return { kept: lines, dropped: 0 };
  const priorityCount = lines.filter(isPriorityNode).length;
  const otherBudget = Math.max(0, max - priorityCount);
  let othersKept = 0;
  const kept = lines.filter((n) => isPriorityNode(n) || othersKept++ < otherBudget);
  return { kept, dropped: lines.length - kept.length };
}

// Format the captured snapshots into the compact text block inlined in the prompt.
export function formatDomSnapshot(snaps: RouteSnapshot[]): string {
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.error) {
      lines.push(`route ${s.route}: (could not capture — ${s.error})`);
      continue;
    }
    const all = s.nodes ?? [];
    // Over budget: keep EVERY priority (table/list) node, then fill the remaining budget with the
    // rest in document order. Guarantees the author always sees the table that drives its selectors.
    const { kept: nodes } = capDomLines(all, MAX_NODES_PER_ROUTE);
    lines.push(`route ${s.route}:`);
    for (const n of nodes) lines.push(`  ${n}`);
    if (all.length > nodes.length) lines.push(`  … (${all.length - nodes.length} more non-table elements omitted)`);
  }
  return lines.join("\n");
}

// Capture the live DOM for the routes the spec targets. Returns undefined when there is nothing to
// capture or the render is unavailable — review then degrades to "defer on unverifiable UI facts"
// (the prompt's stay-in-your-lane rule), never blocked. Best-effort by design.
export async function captureDom(input: CaptureDomInput, deps: CaptureDomDeps): Promise<string | undefined> {
  const routes = extractTargetRoutes(input.specContents);
  if (routes.length === 0 || !input.baseUrl) return undefined; // benign: nothing to ground against
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, routes);
    const text = formatDomSnapshot(snaps);
    if (text.trim()) return text;
    // Routes WERE extractable and a baseUrl WAS present, yet the render produced nothing. That is a
    // real grounding GAP, not a benign no-op — surface it loudly (CLAUDE.md: never swallow into an
    // empty result), so a run that authors/judges selectors WITHOUT the live DOM is visible.
    console.warn(`[qa] WARNING: DOM grounding produced no snapshot for ${routes.length} route(s) [${routes.join(", ")}] — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined;
  } catch (err) {
    console.warn(`[qa] WARNING: DOM grounding FAILED to capture ${routes.length} route(s) [${routes.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined; // never let a capture failure break the run
  }
}

// Capture the live a11y tree for EXPLICIT routes (not extracted from a spec). Used to ground the
// fan-out workers BEFORE they write — the planner hands each objective a concrete navigable route, we
// render it once and inject the tree so the worker transcribes real selectors instead of guessing.
// Best-effort and degradation-safe: no routes / no baseUrl / a failed render all return undefined,
// and the caller falls back to the worker exploring with its own Playwright MCP (today's behavior).
export async function captureDomForRoutes(
  routes: string[],
  input: { e2eDir: string; baseUrl?: string },
  deps: CaptureDomDeps,
): Promise<string | undefined> {
  const clean = normalizeRoutes(routes).slice(0, MAX_ROUTES);
  if (clean.length === 0 || !input.baseUrl) return undefined;
  try {
    const text = formatDomSnapshot(await deps.render(input.e2eDir, input.baseUrl, clean));
    return text.trim() ? text : undefined;
  } catch {
    return undefined; // degrade to the worker's own exploration; never break the run
  }
}

// Capture the live a11y tree for explicit routes, returned PER ROUTE (route → formatted block) so the
// fan-out can ground EACH objective with ONLY its own routes' DOM, not one shared blob. The whole set
// is rendered ONCE (a route shared by two objectives is not re-rendered) and split by route. Routes
// are taken from each brief's code-derived `routes[]` — the real router paths — so this does NOT key
// on the planner's `verified` flag (the planner no longer navigates to set it; see the F1/F3 seam).
// Best-effort: no routes / no baseUrl / a failed render → empty map, and each objective then degrades
// independently (an objective whose routes are absent from the map routes to the strong agent).
//
// Soft-404 / SPA-shell guard: a hash-routed SPA (e.g. AngularJS "/#!/owners") answers 200 with the
// SAME shell DOM for every path, so the rendered routes share one byte-identical node set. That is NOT
// route-specific grounding — injecting it would teach a worker shell selectors as if they were the
// route's. We drop a node set ONLY when it is shared by a MAJORITY of the rendered routes (the
// signature of a real shell served for every path): `count >= 2 AND count > routes/2`. This avoids the
// false-positive of dropping two genuinely-distinct pages that merely share interactive chrome (their
// pair is not a majority of a >=4-route set), and a single unique route is never dropped (count 1).
export async function captureDomByRoute(
  routes: string[],
  input: { e2eDir: string; baseUrl?: string },
  deps: CaptureDomDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const normalized = normalizeRoutes(routes);
  const clean = normalized.slice(0, MAX_ROUTES_UNION);
  if (clean.length === 0 || !input.baseUrl) return out;
  // Surface a truncated union loudly (CLAUDE.md: never silently drop) — the dropped routes' objectives
  // get no DOM and degrade to the fallback, so the operator must be able to see it happened.
  if (normalized.length > clean.length) {
    console.warn(`[qa] WARNING: ${normalized.length} planned routes exceed the render cap (${MAX_ROUTES_UNION}); ${normalized.length - clean.length} route(s) are NOT grounded this run: ${normalized.slice(clean.length).join(", ")}`);
  }
  let snaps: RouteSnapshot[];
  try {
    snaps = await deps.render(input.e2eDir, input.baseUrl, clean);
  } catch {
    return out; // degrade: every objective falls back independently
  }
  // Count how many routes produced each distinct node-set signature, to detect a shared-shell soft-404.
  const sig = (s: RouteSnapshot): string => (s.nodes ?? []).join("\n");
  const rendered = snaps.filter((s) => !s.error && s.nodes?.length);
  const occurrences = new Map<string, number>();
  for (const s of rendered) occurrences.set(sig(s), (occurrences.get(sig(s)) ?? 0) + 1);
  const isSharedShell = (s: RouteSnapshot): boolean => {
    const count = occurrences.get(sig(s)) ?? 0;
    return count >= 2 && count > rendered.length / 2; // a real shell is served for the MAJORITY of paths
  };
  for (const s of rendered) {
    if (isSharedShell(s)) continue; // shared shell across most routes → not route-specific
    const text = formatDomSnapshot([s]);
    if (text.trim()) out.set(s.route, text);
  }
  return out;
}

// Capture the per-route RAW node lines (`RouteSnapshot.nodes`) for the routes a SPEC targets — for the
// PRE-EXECUTION deterministic selector check (Lever-2 / checkSpecSelectors). Unlike captureDomByRoute
// (which formats per route and drops shared shells for worker grounding), this returns the raw nodes and
// applies NO shell-dedup: for strict-mode AMBIGUITY the real rendered tree IS the thing to check against,
// whatever the app's routing or rendering. Agnostic and best-effort: no routes / no baseUrl / a failed
// render / errored or empty-node routes all yield [] — the pre-execution signal is simply absent, never a
// break (the deterministic guarantee rests on the always-available post-failure path, not on this).
export async function captureRouteTrees(input: CaptureDomInput, deps: CaptureDomDeps): Promise<RouteSnapshot[]> {
  const routes = extractTargetRoutes(input.specContents);
  if (routes.length === 0 || !input.baseUrl) return [];
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, routes);
    return snaps.filter((s) => !s.error && (s.nodes?.length ?? 0) > 0);
  } catch {
    return []; // degrade: no pre-execution signal, never break the run
  }
}

// Parses the YAML string returned by `locator('body').ariaSnapshot()` (Playwright >=1.57) into
// "role: name" lines for the interactive/labelled nodes the reviewer cares about. Pure — exported
// for testing. Replaces the JSON-tree walk of `flattenAccessibilityTree` (removed in PW 1.57);
// the output contract ("role: name" lines) is IDENTICAL so formatDomSnapshot is unchanged.
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
  ]);
  // Roles whose mere PRESENCE is informative even WITHOUT an accessible name, so we emit a bare
  // "(present)" marker instead of dropping them:
  //  • landmarks (table/grid/list/row) — lets the author see "there is a table here" and reason about
  //    which roles it actually exposes (e.g. cells but no columnheader) vs assuming HTML-implied roles.
  //  • form inputs (textbox/combobox/checkbox/radio) — a form whose <label> is NOT associated (no
  //    for/id, common in apps like PetClinic) leaves the input UNNAMED; without this it is DROPPED and
  //    the whole form goes INVISIBLE to grounding, so the reviewer can't confirm the author's selectors
  //    and falsely REJECTS them. The marker says the field EXISTS → target it by attribute/position.
  const structural = new Set(["table", "grid", "list", "row", "textbox", "combobox", "checkbox", "radio"]);

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

// The render child loops routes SEQUENTIALLY (each goto bounded at 15s) and writes its result ONCE at
// the end, so a kill mid-flight loses EVERY route, not just the slow one. Scale the kill deadline with
// the route count (each route's 15s goto must fit) so the union render actually completes; cap it so a
// pathological plan can't hold the orchestrator indefinitely. (For a single route this is still 35s.)
const RENDER_BASE_TIMEOUT_MS = 20_000;
const RENDER_PER_ROUTE_TIMEOUT_MS = 15_000;
const RENDER_MAX_TIMEOUT_MS = 200_000;
const renderTimeoutFor = (routeCount: number): number =>
  Math.min(RENDER_BASE_TIMEOUT_MS + Math.max(1, routeCount) * RENDER_PER_ROUTE_TIMEOUT_MS, RENDER_MAX_TIMEOUT_MS);

// Real render: a short Node script run with the e2e project's Playwright (its node_modules + the
// baked browsers), under the same scrubbed env as execution. The orchestrator root has no
// Playwright, so we borrow the watched repo's — exactly as execute.ts spawns it.
export const defaultCaptureDomDeps: CaptureDomDeps = {
  render: (e2eDir, baseUrl, routes) =>
    new Promise<RouteSnapshot[]>((resolve) => {
      const work = mkdtempSync(join(tmpdir(), "qa-dom-"));
      const script = join(work, "capture.cjs");
      // routes + baseUrl come from AGENT-AUTHORED specs (untrusted in this threat model). They are
      // passed to the child via an ENV var and parsed there, NOT interpolated into the script source
      // — JSON.stringify does not escape U+2028/U+2029, so interpolating untrusted strings into JS
      // source could inject. The require() path is a derived LOCAL path (not agent input), so its
      // interpolation is safe.
      writeFileSync(
        script,
        `const { chromium } = require(${JSON.stringify(join(e2eDir, "node_modules", "playwright"))});
const { baseUrl, routes } = JSON.parse(process.env.PW_CAPTURE_INPUT || "{}");
(async () => {
  const out = [];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext()).newPage();
    for (const route of routes) {
      try {
        await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle", timeout: 15000 });
        // ariaSnapshot() (PW >=1.57) returns a YAML string; page.accessibility.snapshot() was removed.
        out.push({ route, yaml: await page.locator('body').ariaSnapshot() });
      } catch (e) { out.push({ route, error: String(e && e.message || e).slice(0, 200) }); }
    }
  } catch (e) { process.stderr.write(String(e)); } finally { if (browser) await browser.close().catch(() => {}); }
  process.stdout.write(JSON.stringify(out));
})();`,
      );
      let stdout = "";
      // detached → own process group so the timeout kill reaps the chromium grandchildren too (a
      // plain child.kill would orphan them). scrubEnv(/^DEV_/) keeps the app's DEV_* login creds so
      // gated routes snapshot the real page, not the login screen (same env as execute.ts).
      const child = spawn("node", [script], {
        cwd: e2eDir,
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_CAPTURE_INPUT: JSON.stringify({ baseUrl, routes }) },
        detached: true,
      });
      const timer = setTimeout(() => killTree(child), renderTimeoutFor(routes.length));
      child.stdout.on("data", (d) => (stdout += d.toString()));
      const done = (snaps: RouteSnapshot[]): void => { clearTimeout(timer); try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } resolve(snaps); };
      child.on("error", () => done([]));
      child.on("close", () => {
        try {
          const raw = JSON.parse(stdout) as Array<{ route: string; yaml?: string; error?: string }>;
          done(raw.map((r) => (r.error ? { route: r.route, error: r.error } : { route: r.route, nodes: parseAriaSnapshot(r.yaml ?? "") })));
        } catch {
          done([]);
        }
      });
    }),
};

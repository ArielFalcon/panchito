// qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts
// PORT (verbatim behavior) of src/qa/dom-snapshot.ts — deterministic DOM grounding for the independent
// reviewer. The reviewer judged UI facts (button labels, link text, routes) from its TRAINING memory
// of "similar apps" and hallucinated corrections (it claimed PetClinic's submit button says "Add Owner"
// when the live DOM says "Submit"), which burned regeneration rounds and poisoned the ledger with rules
// built on false facts. The fix: the ORCHESTRATOR (not the generator — independence holds) renders the
// routes the spec targets ONCE and captures the real roles + accessible names, which are inlined into
// the reviewer prompt so it grounds its UI claims in reality.
//
// The render reuses the watched repo's e2e Playwright project (the pinned version + the baked
// browsers) via a child process, the SAME pattern as src/qa/execute.ts — the orchestrator root has
// no Playwright of its own. The render is the deliberately-uncovered integration boundary; the
// route extraction and snapshot formatting (the deterministic core) are unit-tested.
//
// Circular pair with route-catalog.ts (see that file's header) — ported TOGETHER, co-located here.
// scrubEnv/killTree are consumed from qa-engine's already-ported process-sandbox leaf primitives
// (Plan 7.2) instead of re-porting them — same "reuse the leaf, don't re-port" discipline Plan 7.3's
// runbinary.ts established for the static-signal extractors. killTree is now a ProcessKillPort method
// (ProcessKillAdapter), not a bare function, so it is instantiated once at module scope.

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { buildRouteCatalog, buildTestIdIndex, degradedRouteWarning, hasRuntimeErrorSignal, ROUTE_STATUS } from "./route-catalog.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";

const processKill = new ProcessKillAdapter();

// Stable HTML attributes for one interactive or labelled node. `key` equals the
// "role: name" line that parseAriaSnapshot produced for this node — it is the join key
// between attrs[] and nodes[]. All attribute fields are optional; an entry with no
// stable attributes is not emitted. selector-check.ts NEVER reads attrs[]; only
// formatDomSnapshot does, for the PROMPT text only.
export interface NodeAttr {
  key: string; // "role: name" join key (e.g. "button: Submit") — bare, no state suffix
  testId?: string; // value of the configured testIdAttribute (e.g. data-testid or data-cy)
  id?: string; // HTML id attribute
  name?: string; // HTML name attribute (inputs, forms)
  href?: string; // relative href (links) — a same-origin path hint, not the full URL
  // Seam C (Slice 3): optional input metadata — advisory to the agent; absence = today's behavior
  inputType?: string; // e.g. "password", "date", "email", "file", "tel", "number", "search"
  nameFallback?: string; // placeholder/aria-label/aria-labelledby when computedName is blank
}

// Raw attribute entry from the in-page walk before merging.
export interface RawAttr {
  key: string; // "role: name" join key — computedRole + ": " + computedName
  testId?: string;
  id?: string;
  name?: string;
  href?: string;
  // Seam C (Slice 3): optional input metadata captured by the in-page walk
  inputType?: string; // type attribute of <input>/<textarea>
  nameFallback?: string; // placeholder > aria-label > aria-labelledby when computedName is blank
}

// One captured route: the accessible roles+names the reviewer judges UI facts against.
export interface RouteSnapshot {
  route: string;
  nodes?: string[]; // "role: name" lines (interactive/labelled elements only) — BYTE-IDENTICAL to parseAriaSnapshot output; NO state suffixes
  attrs?: NodeAttr[]; // parallel stable-attribute map, keyed by the same "role: name" join key; NEVER modifies nodes[]
  // Seam A (Slice 3): parallel state map — key = bare "role: name" (same join key as nodes[]/attrs[]);
  // value = array of state tokens (e.g. ["disabled"]). DISPLAY-ONLY — rendered by formatDomSnapshot
  // as a suffix after the attr hint and before [CHANGED:]. NEVER written into nodes[].
  states?: Map<string, string[]>;
  testIdAttrName?: string; // the configured testIdAttribute name used during capture (e.g. "data-cy"); defaults to "data-testid" in formatDomSnapshot
  testIds?: Map<string, number>; // Pillar 2 catalog: role-independent test-id value→count index (presence + uniqueness) — feeds the pre-execution selector gate
  settled?: boolean; // Pillar 2 (Slice 2): a SECONDARY waitForLoadState("networkidle") AFTER goto resolved within budget → the catalog is post-hydration and the gate may fail-closed. Absent/false ⇒ possibly pre-hydration ⇒ advisory only.
  error?: string; // capture failed for this route (degrade — never blocks review)
  // Fix 2 (audit leak 5): RAW captured browser runtime signals — the child script does NOT classify
  // these; classification (mirroring src/qa/failure-adjudicator.ts's FRAMEWORK_ERROR_RE/BENIGN_NOISE_RE)
  // happens in route-catalog.ts's buildRouteCatalog. Reset per route (never accumulated across routes).
  runtimeErrors?: { type: string; text: string }[];
  finalUrl?: string; // page.url() after the settle probe — lets buildRouteCatalog detect a redirect
                      // (e.g. bounced to a login page) by comparing pathnames against the requested route.
}

export interface CaptureDomInput {
  e2eDir: string; // the seeded e2e project (its node_modules has the pinned Playwright)
  baseUrl: string; // live DEV
  specContents: string[]; // the spec sources, to extract the routes they navigate
  testIdAttribute?: string; // config-declared convention (e.g. "data-cy"); threaded to render so the
                            // in-page attribute walk queries the right attribute. Absent → render defaults to "data-testid".
}

export interface CaptureDomDeps {
  // Renders each route against DEV and returns its accessible nodes. Injected so the deterministic
  // core is testable without a browser; defaultCaptureDomDeps spawns the e2e project's Playwright.
  // testIdAttribute is the configured attribute name for getByTestId (e.g. "data-cy"). Defaults to
  // "data-testid" when absent. Passed through to the in-page attribute walk and the spawn env.
  render(e2eDir: string, baseUrl: string, routes: string[], testIdAttribute?: string): Promise<RouteSnapshot[]>;
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

// Trailing ARIA-state tokens that Playwright appends AFTER the accessible name (e.g.
// `button "Submit" [disabled]`). An ALLOWLIST, never a generic `[...]` strip: a generic strip
// truncates real accessible names that legitimately end in brackets (badge counts "Inbox [5]",
// draft markers "Edit [Draft]"), which collides distinct siblings in the join and misses the
// state lookup. Token set mirrors the capture side (STATE_RE) plus pressed/level for safety.
const ARIA_STATE_STRIP_RE = /(?:\s*\[(disabled|expanded|checked|required|selected|pressed|level=\d+)\])+\s*$/;

// Seam D (Slice 3): Normalize a "role: name [state]" join key to its bare canonical form.
// FIRST strip a trailing ARIA-state suffix (allowlist only — never a real bracketed name), THEN
// trim and collapse internal whitespace to a single space. Order matters: strip state before
// collapsing so " [disabled]" doesn't leave a trailing space that survives the collapse.
// Exported for unit testing and mergeAttrs.
export function normalizeKey(s: string): string {
  return s.replace(ARIA_STATE_STRIP_RE, "").replace(/\s+/g, " ").trim();
}

// Gate Delta 1 (Slice 3): interactive roles that must be preserved BEFORE landmarks/other
// non-priority nodes. button/link/textbox/combobox are the critical selector-authoring roles —
// evicting them in favor of landmark banners is the "author sees empty form" failure mode.
const INTERACTIVE_ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio"];
const isInteractiveNode = (line: string): boolean => INTERACTIVE_ROLES.some((r) => line.startsWith(`${r}:`));

// Caps a "role: name" line set to `max`, keeping EVERY priority (table/list) node, then
// EVERY interactive node (button/link/textbox/combobox/checkbox/radio), then filling the
// remaining budget with the rest (landmarks and other non-priority) in document order.
// Three-tier: priority → interactive → other. Interactive tier is the Gate Delta 1 fix:
// without it, landmark roles (navigation/banner/main) filled the remaining budget in
// document order before interactive elements, evicting buttons on landmark-heavy pages.
// Returns the kept lines plus how many were dropped, so a caller can note the omission. Exported
// for the fix-loop prompt (buildFailureDom), which caps the readable block, NOT the stored tree.
export function capDomLines(lines: string[], max: number): { kept: string[]; dropped: number } {
  if (lines.length <= max) return { kept: lines, dropped: 0 };
  const priorityCount = lines.filter(isPriorityNode).length;
  const afterPriority = Math.max(0, max - priorityCount);
  const interactiveNonPriority = lines.filter((n) => !isPriorityNode(n) && isInteractiveNode(n));
  const interactiveCount = Math.min(interactiveNonPriority.length, afterPriority);
  const otherBudget = Math.max(0, afterPriority - interactiveCount);
  let interactiveKept = 0;
  let othersKept = 0;
  const kept = lines.filter((n) => {
    if (isPriorityNode(n)) return true; // tier 1: always kept
    if (isInteractiveNode(n)) return interactiveKept++ < interactiveCount; // tier 2: interactive
    return othersKept++ < otherBudget; // tier 3: landmarks and other
  });
  return { kept, dropped: lines.length - kept.length };
}

// Build a compact attribute hint bracket for a node's NodeAttr, e.g. "[data-cy=submit id=btn]".
// Rules: testId first, then id, then name, then href (relative only), then type= (inputType),
// then nameFallback. Budget ~40 chars total inside the brackets; seam C fields are appended
// after stable attrs within the same budget (truncated as today). Absent fields → no token.
// Returns empty string when no value is present (caller must suppress the hint).
function buildAttrHint(attr: NodeAttr, testIdAttrName: string): string {
  const parts: string[] = [];
  if (attr.testId !== undefined) parts.push(`${testIdAttrName}=${attr.testId}`);
  else if (attr.id !== undefined) parts.push(`id=${attr.id}`);
  else if (attr.name !== undefined) parts.push(`name=${attr.name}`);
  else if (attr.href !== undefined) parts.push(attr.href);
  // Seam C (Slice 3): advisory type= and name fallback — appended after stable attrs
  if (attr.inputType !== undefined) parts.push(`type=${attr.inputType}`);
  if (attr.nameFallback !== undefined) parts.push(attr.nameFallback);
  if (parts.length === 0) return "";
  const raw = parts.join(" ");
  // Bracket budget: keep it compact (≤40 chars inside the brackets).
  const inner = raw.length > 40 ? raw.slice(0, 40) : raw;
  return `[${inner}]`;
}

// Whether a "role: name" line is a structural marker or text node that must NEVER receive an
// attribute hint. Markers carry no stable identity that maps to an HTML element attribute.
function isMarkerLine(line: string): boolean {
  return line.includes(": (present)") || line.startsWith("text: ");
}

// Pure function that appends a [CHANGED: …] marker suffix when a captured node matches
// a ChangedElement from the diff. Match priority: testId → id → name → href → text fallback.
// Returns " [CHANGED: <why>]" on match, "" on no-match (the caller appends the return value).
// The marker lives ONLY in the formatted string — NEVER in nodes[] or attrs[].
export function buildChangedMarker(
  line: string,
  attr: NodeAttr | undefined,
  changed: ChangedElement[],
  testIdAttrName: string = "data-testid",
): string {
  if (!changed.length) return "";

  for (const c of changed) {
    // Primary: stable-attr matches (most precise; same discipline as mergeAttrs)
    if (c.testId !== undefined && attr?.testId === c.testId) {
      return ` [CHANGED: added ${testIdAttrName}=${c.testId}]`;
    }
    if (c.id !== undefined && attr?.id === c.id) {
      return ` [CHANGED: added id=${c.id}]`;
    }
    if (c.name !== undefined && attr?.name === c.name) {
      return ` [CHANGED: added name=${c.name}]`;
    }
    if (c.href !== undefined && attr?.href === c.href) {
      return ` [CHANGED: new link → ${c.href}]`;
    }
    // Secondary: text fallback — match only on whitespace-word boundaries, not arbitrary substring.
    // The line is "role: name" — extract the name part after ": ".
    // A guidance phrase like "test" must NOT match "test-submission" (hyphenated compound),
    // because that actively misleads the agent: prefer UNDER-marking over spurious markers.
    // Word-boundary rule: the node name is split on WHITESPACE only (not hyphens/underscores),
    // so "test-submission" is one token and "test" alone does NOT match it.
    // "form" DOES match "Contact form submit" because they are whitespace-separated words.
    if (c.text !== undefined) {
      const colonIdx = line.indexOf(": ");
      const rawNodeName = colonIdx !== -1 ? line.slice(colonIdx + 2).trim() : line.trim();
      // Task 2.2 (Slice 3): strip trailing ARIA state token suffix from the name portion —
      // defensive insurance so a line like "Submit [disabled]" doesn't make "[disabled]"
      // a spurious word-token in the whitespace-split match below.
      // ALLOWLIST — strips ONLY known ARIA interactive-state tokens (same set as selector-check.ts
      // parseLine): disabled, expanded, checked, required, selected, pressed, level=<digits>.
      // Real accessible names ending in brackets ("Inbox [5]", "Edit [Draft]") are preserved
      // so the exact/word match below fires correctly when c.text carries the full bracketed name.
      const nodeName = rawNodeName.replace(ARIA_STATE_STRIP_RE, "").trim();
      if (nodeName) {
        const textLower = c.text.toLowerCase();
        const nodeNameLower = nodeName.toLowerCase();
        // Exact equality (case-insensitive) always matches.
        const exactMatch = nodeNameLower === textLower;
        // Whole-word match: split on whitespace only. Hyphenated compounds (e.g. "test-submission")
        // remain one token and will not match a sub-string like "test".
        const nodeWords = nodeNameLower.split(/\s+/).filter(Boolean);
        const wordMatch = nodeWords.includes(textLower);
        if (exactMatch || wordMatch) {
          return ` [CHANGED: added text "${c.text}"]`;
        }
      }
    }
  }
  return "";
}

// Format the captured snapshots into the compact text block inlined in the prompt.
// When a RouteSnapshot carries attrs[], a compact " -> [attr]" hint is appended AFTER
// each kept line whose join key matches a NodeAttr with at least one stable value.
// Structural markers ("(present)") and text: lines NEVER receive a hint.
// The optional `changed` param appends a [CHANGED: …] marker on matched lines (AFTER the -> hint).
// The nodes[] array is NEVER modified — the hint and marker are PROMPT TEXT ONLY.
// selector-check.ts consumes only raw nodes[], not the formatted prompt text.
export function formatDomSnapshot(snaps: RouteSnapshot[], changed?: ChangedElement[]): string {
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.error) {
      lines.push(`route ${s.route}: (could not capture — ${s.error})`);
      continue;
    }
    // A route that STRUCTURALLY failed to render (empty nodes, capture error, or a redirect — the
    // buildRouteCatalog degrade policy) gets a warning line instead of a silent bare header and its
    // nodes are NOT rendered: the agent must not trust this route's grounding.
    if (buildRouteCatalog(s).status === ROUTE_STATUS.DEGRADED) {
      lines.push(`route ${s.route}: (route rendered empty or errored — possibly broken app; verify live)`);
      continue;
    }
    // Live-probe fix: a route that DID render but whose app logged a runtime error (a missing icon, an
    // uncaught handler, a framework error) stays a TRUSTED grounding source — its nodes ARE rendered
    // below — but the agent still gets an advisory heads-up so it verifies live and does not blindly
    // assert app-generated content. This warning is DECOUPLED from grounding trust: the route is
    // captured, the selectors are real, only the app's own health is in question.
    const runtimeErrorAdvisory = hasRuntimeErrorSignal(s.runtimeErrors ?? [])
      ? " (note: the app logged runtime errors — possibly a defect; verify live before asserting on app-generated content)"
      : "";
    const all = s.nodes ?? [];
    // Over budget: keep EVERY priority (table/list) node, then fill the remaining budget with the
    // rest in document order. Guarantees the author always sees the table that drives its selectors.
    const { kept: nodes } = capDomLines(all, MAX_NODES_PER_ROUTE);
    // Build lookup map for attrs if present (O(1) per line).
    const attrMap = s.attrs && s.attrs.length > 0
      ? new Map(s.attrs.map((a) => [a.key, a]))
      : null;
    const testIdAttrName = s.testIdAttrName ?? "data-testid";
    // When changed is provided and non-empty, we append [CHANGED: …] markers to matched lines.
    // When absent/empty, the loop is byte-identical to today's output.
    const useChanged = changed && changed.length > 0;
    // Seam A (Slice 3): states map for this snapshot — keyed by bare "role: name" join key.
    // State tokens are rendered DISPLAY-ONLY as a suffix after the attr hint and before [CHANGED:].
    // They NEVER appear on structural "(present)" marker lines.
    const stateMap = s.states && s.states.size > 0 ? s.states : null;
    lines.push(`route ${s.route}:${runtimeErrorAdvisory}`);
    for (const n of nodes) {
      // State suffix: rendered only for non-marker lines. The attrMap lookup uses the bare key
      // (normalizeKey strips state if nodes[] ever carries a suffix — defensive); the state is looked
      // up by the bare node string (nodes[] is always bare per the Option A invariant).
      const stateSuffix = (!isMarkerLine(n) && stateMap?.get(normalizeKey(n)))
        ? ` [${stateMap.get(normalizeKey(n))!.join("] [")}]`
        : "";
      if (attrMap && !isMarkerLine(n)) {
        const attr = attrMap.get(normalizeKey(n)) ?? attrMap.get(n);
        if (attr) {
          const hint = buildAttrHint(attr, testIdAttrName);
          if (hint) {
            const changedMarker = useChanged ? buildChangedMarker(n, attr, changed!, testIdAttrName) : "";
            lines.push(`  ${n}  -> ${hint}${stateSuffix}${changedMarker}`);
            continue;
          }
        }
      }
      // No hint path: state suffix + changed marker (text fallback, or attr match without hint)
      const changedMarker = useChanged && !isMarkerLine(n) ? buildChangedMarker(n, attrMap?.get(normalizeKey(n)) ?? attrMap?.get(n), changed!, testIdAttrName) : "";
      lines.push(`  ${n}${stateSuffix}${changedMarker}`);
    }
    if (all.length > nodes.length) lines.push(`  … (${all.length - nodes.length} more non-table elements omitted)`);
    // FIX B (Pillar 2 / Slice 2): role-less hint-parity block. A <div data-cy=x> with no ARIA role
    // is captured into testIds (role-independent pass) but is invisible in the ARIA nodes[] above.
    // Render a separate block so the agent can DISCOVER every test-id the gate will accept, preventing
    // catalog/hint divergence and eliminating the fabrication trigger for role-less test-ids.
    // count===1 → bare value; count>1 → value (×N) ambiguity marker. Bounded to MAX_NODES_PER_ROUTE
    // values; excess is summarized as "(+k more)" so the prompt is never unbounded. Comma-joined: test-id
    // conventions (kebab/camel/snake) never contain ", ", so values need no escaping.
    if (s.testIds && s.testIds.size > 0) {
      const entries = [...s.testIds.entries()];
      const cap = MAX_NODES_PER_ROUTE;
      const shown = entries.slice(0, cap);
      const overflow = entries.length - shown.length;
      const parts = shown.map(([v, count]) => count > 1 ? `${v} (×${count})` : v);
      if (overflow > 0) parts.push(`(+${overflow} more)`);
      lines.push(`  test-ids on this route: ${parts.join(", ")}`);
    }
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
    const snaps = await deps.render(input.e2eDir, input.baseUrl, routes, input.testIdAttribute);
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
// The optional `changed` arg (Slice 1) is forwarded to formatDomSnapshot for [CHANGED: …] annotation.
// Absent → byte-identical to today.
export async function captureDomForRoutes(
  routes: string[],
  input: { e2eDir: string; baseUrl?: string; testIdAttribute?: string },
  deps: CaptureDomDeps,
  changed?: ChangedElement[],
): Promise<string | undefined> {
  const clean = normalizeRoutes(routes).slice(0, MAX_ROUTES);
  if (clean.length === 0 || !input.baseUrl) return undefined;
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, clean, input.testIdAttribute);
    // Per-route degrade: surface errored routes loudly (same as captureRouteTrees/captureDomByRoute —
    // CLAUDE.md: never swallow a capture failure) before formatting for the worker.
    const w = degradedRouteWarning(snaps.map(buildRouteCatalog));
    if (w) console.warn(w);
    const text = formatDomSnapshot(snaps, changed);
    return text.trim() ? text : undefined;
  } catch (err) {
    console.warn(`[qa] WARNING: DOM capture FAILED for ${clean.length} route(s) [${clean.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — the worker grounds via its own exploration this run.`);
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
  input: { e2eDir: string; baseUrl?: string; changedElements?: ChangedElement[]; testIdAttribute?: string },
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
    snaps = await deps.render(input.e2eDir, input.baseUrl, clean, input.testIdAttribute);
  } catch (err) {
    console.warn(`[qa] WARNING: DOM capture FAILED for ${clean.length} route(s) [${clean.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — each objective falls back to its own exploration this run.`);
    return out; // degrade: every objective falls back independently
  }
  // Per-route degrade: surface errored routes loudly (same pattern as captureRouteTrees — CLAUDE.md:
  // never swallow a capture failure) before filtering them out for grounding.
  const w = degradedRouteWarning(snaps.map(buildRouteCatalog));
  if (w) console.warn(w);
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
    const text = formatDomSnapshot([s], input.changedElements);
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
  let snaps: RouteSnapshot[];
  try {
    snaps = await deps.render(input.e2eDir, input.baseUrl, routes, input.testIdAttribute);
  } catch (err) {
    // Loud, attributed degrade (CLAUDE.md: never swallow a capture failure into []). The whole render
    // threw → no pre-execution selector grounding this run; the gate has nothing and stays advisory.
    console.warn(`[qa] WARNING: DOM capture FAILED for ${routes.length} route(s) [${routes.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — no pre-execution selector grounding this run.`);
    return [];
  }
  // Per-route degrade (render succeeded but some routes errored): name them loudly before filtering, so
  // a partially-grounded run is visible and attributed rather than a silent reopen.
  const warning = degradedRouteWarning(snaps.map(buildRouteCatalog));
  if (warning) console.warn(warning);
  // Keep a route with a populated test-id index even when its ARIA nodes[] is empty — a page of
  // role-less <div data-cy=x> elements is exactly what the role-independent capture (Pillar 2) exists
  // to ground, and the catalog gate must see it. Errored routes are still dropped.
  return snaps.filter((s) => !s.error && ((s.nodes?.length ?? 0) > 0 || (s.testIds?.size ?? 0) > 0));
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

// Seam A (Slice 3): parallel state capture — returns nodes[] (bare, byte-identical to
// parseAriaSnapshot output) PLUS a parallel Map<bare-key, state-tokens[]>. The state tokens
// ([disabled]/[expanded]/[checked]/[required]/[selected]) are captured at each of the 3 parse
// paths without modifying the nodes[] join keys. The Map is keyed by the same bare "role: name"
// string so downstream consumers (mergeAttrs, buildChangedMarker, selector-check parseLine)
// remain unaffected. `nodes` field delegates to parseAriaSnapshot; state is collected in a second
// pass over the same YAML using the same grammar. Pure and exported for unit testing.
export function parseAriaSnapshotWithState(yaml: string): { nodes: string[]; states: Map<string, string[]> } {
  const nodes = parseAriaSnapshot(yaml);
  const states = new Map<string, string[]>();
  // Regex for the interactive state tokens we capture (not level= — not interactive state)
  const STATE_RE = /\[(disabled|expanded|checked|required|selected)\]/g;
  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim();
    if (rest.startsWith("/")) continue;
    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    const afterRole = rest.slice(role.length);
    // Determine bare key using the same logic as parseAriaSnapshot
    let bareName: string | null = null;
    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      if (name) bareName = name;
      // unnamed quoted → structural (present) or dropped — state not captured for (present) lines
    } else {
      const colonIdx = afterRole.indexOf(":");
      if (colonIdx !== -1) {
        const afterColon = afterRole.slice(colonIdx + 1).trim();
        if (afterColon) {
          const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
          if (name) bareName = name;
        }
        // bare colon or empty → (present) marker — no state captured on structural markers
      }
      // no colon → (present) or dropped — no state captured
    }
    if (!bareName) continue; // unnamed / structural present marker → skip state capture
    const bareKey = `${role}: ${bareName}`;
    // Only capture state if this key is actually in nodes[] (i.e. the role was in keep)
    if (!nodes.includes(bareKey)) continue;
    STATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const tokens: string[] = [];
    while ((m = STATE_RE.exec(afterRole)) !== null) {
      tokens.push(m[1]!);
    }
    if (tokens.length > 0) states.set(bareKey, tokens);
  }
  return { nodes, states };
}

// Merges a RawAttr[] (from the in-page walk) into NodeAttr[] keyed by the same "role: name"
// join key that parseAriaSnapshot produces. Unmatched RawAttrs (keys not in nodes[]) are
// dropped. On collision (two entries with the same key) the first wins. Pure and exported
// for unit testing.
export function mergeAttrs(nodes: string[], rawAttrs: RawAttr[]): NodeAttr[] {
  if (rawAttrs.length === 0) return [];
  // Task 2.1 (Slice 3): index by NORMALIZED key so whitespace divergence and trailing state
  // suffixes don't cause silent drops. First occurrence wins on collision.
  const byKey = new Map<string, RawAttr>();
  for (const r of rawAttrs) {
    const nk = normalizeKey(r.key);
    if (!byKey.has(nk)) byKey.set(nk, r);
  }
  const out: NodeAttr[] = [];
  const seen = new Set<string>(); // only one NodeAttr per key (first node wins)
  for (const node of nodes) {
    const bareKey = normalizeKey(node); // strip state suffix + whitespace-normalize
    if (seen.has(bareKey)) continue;
    const raw = byKey.get(bareKey);
    if (!raw) continue;
    // Only emit when at least one stable or advisory attribute is present
    if (raw.testId === undefined && raw.id === undefined && raw.name === undefined && raw.href === undefined
      && raw.inputType === undefined && raw.nameFallback === undefined) continue;
    seen.add(bareKey);
    // NodeAttr.key is the NORMALIZED bare key (no state suffix, whitespace-collapsed) — stable join key
    const attr: NodeAttr = { key: bareKey };
    if (raw.testId !== undefined) attr.testId = raw.testId;
    if (raw.id !== undefined) attr.id = raw.id;
    if (raw.name !== undefined) attr.name = raw.name;
    if (raw.href !== undefined) attr.href = raw.href;
    // Seam C: propagate optional input metadata
    if (raw.inputType !== undefined) attr.inputType = raw.inputType;
    if (raw.nameFallback !== undefined) attr.nameFallback = raw.nameFallback;
    out.push(attr);
  }
  return out;
}

// The render child loops routes SEQUENTIALLY (each route bounded at ~15s: goto ≤10s + a ≤5s networkidle
// settle probe — see the in-page script) and writes its result ONCE at the end, so a kill mid-flight
// loses EVERY route, not just the slow one. Scale the kill deadline with the route count (each route's
// ~15s capture must fit RENDER_PER_ROUTE_TIMEOUT_MS) so the union render actually completes; cap it so a
// pathological plan can't hold the orchestrator indefinitely. (For a single route this is still 35s.)
const RENDER_BASE_TIMEOUT_MS = 20_000;
const RENDER_PER_ROUTE_TIMEOUT_MS = 15_000;
const RENDER_MAX_TIMEOUT_MS = 200_000;
const renderTimeoutFor = (routeCount: number): number =>
  Math.min(RENDER_BASE_TIMEOUT_MS + Math.max(1, routeCount) * RENDER_PER_ROUTE_TIMEOUT_MS, RENDER_MAX_TIMEOUT_MS);

// Pure string-builder for the render child's script text — extracted so the httpCredentials wiring
// (Fix 1, audit leak 4) and the runtime-error/redirect capture (Fix 2, audit leak 5) are assertable
// without spawning a real browser. `playwrightRequirePath` defaults to a placeholder so the function
// is callable with no args for script-text assertions in tests; defaultCaptureDomDeps.render passes
// the real derived LOCAL path (not agent input, so its interpolation is safe).
export function buildCaptureScript(playwrightRequirePath = "playwright"): string {
  return `const { chromium } = require(${JSON.stringify(playwrightRequirePath)});
const { baseUrl, routes } = JSON.parse(process.env.PW_CAPTURE_INPUT || "{}");
const testIdAttr = process.env.PW_TEST_ID_ATTRIBUTE || "data-testid";
(async () => {
  const out = [];
  let browser;
  try {
    browser = await chromium.launch();
    // Fix 1 (audit leak 4): DEV_ENV_USER/DEV_ENV_PASS were scrubbed through to the child's env
    // (scrubEnv(/^DEV_/)) but never wired into newContext() — gated routes rendered on the login/401
    // page. Mirrors config/e2e/playwright.config.ts's httpCredentials idiom, scoped to baseUrl's
    // origin so creds never leak to a different-origin auth provider (e.g. Keycloak). Gate is
    // DEV_ENV_USER alone — password defaults to "" — matching playwright.config.ts's
    // \`DEV_ENV_USER ? { username, password: DEV_ENV_PASS ?? "", origin } : undefined\` parity;
    // the previous both-required guard silently dropped credentials whenever only DEV_ENV_USER was set.
    const user = process.env.DEV_ENV_USER;
    const pass = process.env.DEV_ENV_PASS;
    const context = await browser.newContext(user
      ? { httpCredentials: { username: user, password: pass ?? "", origin: new URL(baseUrl).origin } }
      : {});
    const page = await context.newPage();
    // Fix 2 (audit leak 5): per-route runtime-error accumulator. Registered ONCE, reset per route
    // iteration (matches the adjudicator's per-case model) so a broken render (uncaught exception /
    // framework console error) is captured RAW here and classified downstream in route-catalog.ts —
    // the child script never classifies, it only collects.
    let currentRouteErrors = [];
    page.on("pageerror", function(err) { currentRouteErrors.push({ type: "pageerror", text: String(err && err.message || err) }); });
    page.on("console", function(msg) { if (msg.type() === "error") currentRouteErrors.push({ type: "console", text: msg.text() }); });
    for (const route of routes) {
      currentRouteErrors = [];
      try {
        // Primary navigation resolves at domcontentloaded (always yields a DOM, even for a SPA that
        // never reaches network-idle). Settledness is probed SEPARATELY below so a non-settling route
        // still produces an (advisory) catalog instead of throwing and losing the route entirely.
        await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 10000 });
        // Secondary settle probe (Pillar 2 / Slice 2): goto(≤10s) + settle(≤5s) = ≤15s per route =
        // RENDER_PER_ROUTE_TIMEOUT_MS, so renderTimeoutFor always covers the worst case. A route that
        // does not reach networkidle within 5s is marked settled=false (advisory, safe direction) and
        // the capture proceeds rather than losing the route entirely.
        let settled = false;
        try { await page.waitForLoadState("networkidle", { timeout: 5000 }); settled = true; } catch (_settle) {}
        // Fix 2: record the settled URL — buildRouteCatalog compares its pathname against the
        // requested route to detect a redirect (e.g. bounced to a login page).
        const finalUrl = page.url();
        // ariaSnapshot() (PW >=1.57) returns a YAML string; page.accessibility.snapshot() was removed.
        const yaml = await page.locator('body').ariaSnapshot();
        // Attribute walk: after ariaSnapshot(), query interactive/labelled nodes to extract stable
        // HTML attributes. Chromium-only cast for computedRole/computedName (best-effort; wrapped in
        // try/catch — if it throws, attrs is empty and the run degrades to a11y-only grounding).
        // Seam C (Slice 3): SAME evaluate call — extended to also capture inputType and nameFallback
        // for <input>/<textarea> elements. Zero extra Playwright calls.
        let rawAttrs = [];
        try {
          rawAttrs = await page.evaluate(function(testIdAttrName) {
            var sel = 'a[href], button, input, select, textarea, [role], [' + testIdAttrName + '], [id], [name]';
            var els = Array.from(document.querySelectorAll(sel));
            return els.map(function(el) {
              var casted = el;
              var computedRole = '';
              var computedName = '';
              try { computedRole = casted.computedRole || ''; } catch(_e) {}
              try { computedName = casted.computedName || ''; } catch(_e) {}
              if (!computedRole) return null;
              var key = computedRole + ': ' + (computedName || '(present)');
              var result = { key: key };
              var testIdVal = el.getAttribute(testIdAttrName);
              if (testIdVal) result.testId = testIdVal;
              var idVal = el.getAttribute('id');
              if (idVal) result.id = idVal;
              var nameVal = el.getAttribute('name');
              if (nameVal) result.name = nameVal;
              var href = el.getAttribute('href');
              if (href && href.startsWith('/')) result.href = href;
              // Seam C: capture input type and name fallback for <input>/<textarea>
              var tagName = el.tagName.toLowerCase();
              if (tagName === 'input' || tagName === 'textarea') {
                var typeVal = el.getAttribute('type');
                if (typeVal && typeVal !== 'text') result.inputType = typeVal;
                // name fallback only when computedName is blank (i18n-unnamed inputs)
                if (!computedName) {
                  var placeholder = el.getAttribute('placeholder');
                  var ariaLabel = el.getAttribute('aria-label');
                  var ariaLabelledby = el.getAttribute('aria-labelledby');
                  var fallback = placeholder || ariaLabel || '';
                  if (!fallback && ariaLabelledby) {
                    var labelEl = document.getElementById(ariaLabelledby);
                    if (labelEl) fallback = (labelEl.textContent || '').trim();
                  }
                  if (fallback) result.nameFallback = fallback;
                }
              }
              // Only emit if at least one stable or advisory attribute is present
              if (!result.testId && !result.id && !result.name && !result.href && !result.inputType && !result.nameFallback) return null;
              return result;
            }).filter(Boolean);
          }, testIdAttr);
        } catch(_attrErr) { rawAttrs = []; }
        let testIdRawList = [];
        try {
          testIdRawList = await page.evaluate(function(a) {
            return Array.from(document.querySelectorAll('[' + a + ']')).map(function(el) { return el.getAttribute(a); }).filter(function(v) { return v; });
          }, testIdAttr);
        } catch(_e) { testIdRawList = []; }
        out.push({ route, yaml, rawAttrs, testIdRawList, testIdAttr, settled, runtimeErrors: currentRouteErrors, finalUrl });
      } catch (e) { out.push({ route, error: String(e && e.message || e).slice(0, 200), runtimeErrors: currentRouteErrors }); }
    }
  } catch (e) { process.stderr.write(String(e)); } finally { if (browser) await browser.close().catch(() => {}); }
  process.stdout.write(JSON.stringify(out));
})();`;
}

// Real render: a short Node script run with the e2e project's Playwright (its node_modules + the
// baked browsers), under the same scrubbed env as execution. The orchestrator root has no
// Playwright, so we borrow the watched repo's — exactly as execute.ts spawns it.
export const defaultCaptureDomDeps: CaptureDomDeps = {
  render: (e2eDir, baseUrl, routes, testIdAttribute = "data-testid") =>
    new Promise<RouteSnapshot[]>((resolve) => {
      const work = mkdtempSync(join(tmpdir(), "qa-dom-"));
      const script = join(work, "capture.cjs");
      // routes + baseUrl come from AGENT-AUTHORED specs (untrusted in this threat model). They are
      // passed to the child via an ENV var and parsed there, NOT interpolated into the script source
      // — JSON.stringify does not escape U+2028/U+2029, so interpolating untrusted strings into JS
      // source could inject. The require() path is a derived LOCAL path (not agent input), so its
      // interpolation is safe.
      writeFileSync(script, buildCaptureScript(join(e2eDir, "node_modules", "playwright")));
      let stdout = "";
      // detached → own process group so the timeout kill reaps the chromium grandchildren too (a
      // plain child.kill would orphan them). scrubEnv({ extraAllowed: /^DEV_/ }) keeps the app's
      // DEV_* login creds so gated routes snapshot the real page, not the login screen (same env
      // as execute.ts).
      const child = spawn("node", [script], {
        cwd: e2eDir,
        env: { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_TEST_ID_ATTRIBUTE: testIdAttribute, PW_CAPTURE_INPUT: JSON.stringify({ baseUrl, routes }) },
        detached: true,
      });
      const timer = setTimeout(() => processKill.killTree(child), renderTimeoutFor(routes.length));
      child.stdout.on("data", (d) => (stdout += d.toString()));
      const done = (snaps: RouteSnapshot[]): void => { clearTimeout(timer); try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } resolve(snaps); };
      child.on("error", (err) => { console.warn(`[qa] WARNING: DOM capture script failed to spawn (${err instanceof Error ? err.message : String(err)}) — no grounding this run.`); done([]); });
      child.on("close", () => {
        try {
          const raw = JSON.parse(stdout) as Array<{ route: string; yaml?: string; rawAttrs?: RawAttr[]; testIdRawList?: string[]; testIdAttr?: string; settled?: boolean; error?: string; runtimeErrors?: { type: string; text: string }[]; finalUrl?: string }>;
          done(raw.map((r) => {
            if (r.error) {
              const errored: RouteSnapshot = { route: r.route, error: r.error };
              // Fix 2: preserve any runtimeErrors collected before the error was thrown (e.g. an
              // uncaught exception fired before goto() rejected) — still useful signal for classification.
              if (r.runtimeErrors && r.runtimeErrors.length > 0) errored.runtimeErrors = r.runtimeErrors;
              return errored;
            }
            // Seam A (Slice 3): use parseAriaSnapshotWithState to populate both nodes[] and the
            // parallel states map. nodes[] is byte-identical to parseAriaSnapshot output (same join keys).
            const { nodes, states } = parseAriaSnapshotWithState(r.yaml ?? "");
            const attrs = r.rawAttrs && r.rawAttrs.length > 0 ? mergeAttrs(nodes, r.rawAttrs) : undefined;
            const snap: RouteSnapshot = { route: r.route, nodes };
            if (attrs && attrs.length > 0) snap.attrs = attrs;
            if (states.size > 0) snap.states = states;
            if (r.testIdAttr) snap.testIdAttrName = r.testIdAttr;
            const testIds = buildTestIdIndex(r.testIdRawList ?? []);
            if (testIds.size > 0) snap.testIds = testIds;
            if (r.settled === true) snap.settled = true; // absent ⇒ buildRouteCatalog defaults to advisory
            // Fix 2 (audit leak 5): thread the RAW runtime signals + settled URL — classification and
            // redirect detection happen in route-catalog.ts's buildRouteCatalog, not here.
            if (r.runtimeErrors && r.runtimeErrors.length > 0) snap.runtimeErrors = r.runtimeErrors;
            if (r.finalUrl) snap.finalUrl = r.finalUrl;
            return snap;
          }));
        } catch {
          console.warn(`[qa] WARNING: DOM capture script produced unparseable output — no grounding this run.`);
          done([]);
        }
      });
    }),
};

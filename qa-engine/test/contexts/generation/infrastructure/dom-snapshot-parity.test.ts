// Parity test: assert the ported qa-engine dom-snapshot functions match the legacy src/qa/
// dom-snapshot.ts byte-for-byte on representative inputs. This file imports from src/ (outside
// qa-engine rootDir) and is excluded from qa-engine typecheck (see qa-engine/tsconfig.json exclude
// list) — identical pattern to symbols-parity.test.ts (Plan 7.3). Runs via tsx at runtime; the
// strangler guard keeping the port honest until Plan 7 cutover deletes the legacy original (Plan 7.4a).
//
// Coverage mirrors BOTH legacy test files' behaviors:
//   - dom-snapshot.test.ts: parseAriaSnapshot, parseAriaSnapshotWithState, formatDomSnapshot,
//     extractTargetRoutes, capDomLines, mergeAttrs, normalizeKey, normalizeRoutes, buildChangedMarker,
//     and the four capture* entry points (deps-injected, no real browser).
//   - dom-snapshot.testid-grounding.test.ts: testIdAttribute forwarding through all four capture
//     entry points (Pillar 1 anti-drift guard), and buildChangedMarker naming the configured attribute.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractTargetRoutes as portedExtractTargetRoutes,
  formatDomSnapshot as portedFormatDomSnapshot,
  parseAriaSnapshot as portedParseAriaSnapshot,
  parseAriaSnapshotWithState as portedParseAriaSnapshotWithState,
  normalizeRoutes as portedNormalizeRoutes,
  normalizeKey as portedNormalizeKey,
  capDomLines as portedCapDomLines,
  isPriorityNode as portedIsPriorityNode,
  mergeAttrs as portedMergeAttrs,
  buildChangedMarker as portedBuildChangedMarker,
  captureDom as portedCaptureDom,
  captureDomForRoutes as portedCaptureDomForRoutes,
  captureDomByRoute as portedCaptureDomByRoute,
  captureRouteTrees as portedCaptureRouteTrees,
  type CaptureDomDeps as PortedCaptureDomDeps,
  type RouteSnapshot as PortedRouteSnapshot,
} from "@contexts/generation/infrastructure/dom-snapshot.ts";

import {
  extractTargetRoutes as legacyExtractTargetRoutes,
  formatDomSnapshot as legacyFormatDomSnapshot,
  parseAriaSnapshot as legacyParseAriaSnapshot,
  parseAriaSnapshotWithState as legacyParseAriaSnapshotWithState,
  normalizeRoutes as legacyNormalizeRoutes,
  normalizeKey as legacyNormalizeKey,
  capDomLines as legacyCapDomLines,
  isPriorityNode as legacyIsPriorityNode,
  mergeAttrs as legacyMergeAttrs,
  buildChangedMarker as legacyBuildChangedMarker,
  captureDom as legacyCaptureDom,
  captureDomForRoutes as legacyCaptureDomForRoutes,
  captureDomByRoute as legacyCaptureDomByRoute,
  captureRouteTrees as legacyCaptureRouteTrees,
  type CaptureDomDeps as LegacyCaptureDomDeps,
  type RouteSnapshot as LegacyRouteSnapshot,
} from "../../../../../src/qa/dom-snapshot.ts";

// ── extractTargetRoutes ───────────────────────────────────────────────────────

test("PARITY: extractTargetRoutes matches legacy — dedup, comments, ${} interpolation, absolute URLs", () => {
  const spec = `
    await page.goto("/#!/owners/new");
    await page.goto('owners');
    await page.goto("/#!/owners/new");
    // await page.goto("/admin");
    await page.goto("https://evil.example/x");
    await page.goto(\`/owners/\${id}\`);
  `;
  assert.deepEqual(portedExtractTargetRoutes([spec]), legacyExtractTargetRoutes([spec]));
});

test("PARITY: extractTargetRoutes bounds match legacy", () => {
  const spec = ["/a", "/b", "/c", "/d", "/e", "/f"].map((r) => `page.goto("${r}")`).join("\n");
  assert.deepEqual(portedExtractTargetRoutes([spec], 3), legacyExtractTargetRoutes([spec], 3));
});

// ── parseAriaSnapshot ────────────────────────────────────────────────────────

test("PARITY: parseAriaSnapshot matches legacy on a real table + presentation-table collapse", () => {
  const yaml = `
- navigation
- link "Register owner"
- button "say \\"hi\\""
- heading "Owners [level=2]"
- textbox
- checkbox "Subscribe" [checked]
- table
  - rowgroup
    - row "Name Address"
      - columnheader "Name"
      - columnheader "Address"
  - rowgroup
    - row
      - cell "Helen Leary"
      - cell "radiology"
    - row
      - cell "Henry Stevens"
      - cell "radiology"
- text: layout cell only
- dialog "Confirm Delete"
- form:
- switch "Dark mode"
- alert:
`.trim();
  assert.deepEqual(portedParseAriaSnapshot(yaml), legacyParseAriaSnapshot(yaml));
});

test("PARITY: parseAriaSnapshot matches legacy on empty input", () => {
  assert.deepEqual(portedParseAriaSnapshot(""), legacyParseAriaSnapshot(""));
  assert.deepEqual(portedParseAriaSnapshot("   \n  \n  "), legacyParseAriaSnapshot("   \n  \n  "));
});

// ── parseAriaSnapshotWithState ───────────────────────────────────────────────

test("PARITY: parseAriaSnapshotWithState matches legacy — bare nodes[] + parallel states map", () => {
  const yaml = '- button "Submit" [disabled]\n- checkbox "Remember me" [checked]\n- textbox "Email" [required] [disabled]';
  const portedResult = portedParseAriaSnapshotWithState(yaml);
  const legacyResult = legacyParseAriaSnapshotWithState(yaml);
  assert.deepEqual(portedResult.nodes, legacyResult.nodes);
  assert.deepEqual([...portedResult.states.entries()], [...legacyResult.states.entries()]);
});

// ── capDomLines / isPriorityNode ─────────────────────────────────────────────

test("PARITY: capDomLines matches legacy — priority/interactive/other three-tier eviction", () => {
  const landmarks = Array.from({ length: 10 }, (_, i) => `navigation: nav-${i}`);
  const interactive = Array.from({ length: 60 }, (_, i) => `button: btn-${i}`);
  const priority = ["table: (present)", "cell: Helen Leary", "cell: radiology"];
  const lines = [...landmarks, ...interactive, ...priority];
  assert.deepEqual(portedCapDomLines(lines, 60), legacyCapDomLines(lines, 60));
});

test("PARITY: isPriorityNode matches legacy for a text: collapse-signal node", () => {
  assert.equal(portedIsPriorityNode("text: layout cell only"), legacyIsPriorityNode("text: layout cell only"));
  assert.equal(portedIsPriorityNode("button: Submit"), legacyIsPriorityNode("button: Submit"));
});

// ── normalizeKey / normalizeRoutes ───────────────────────────────────────────

test("PARITY: normalizeKey matches legacy — strips ARIA state, preserves real bracket names", () => {
  const inputs = [
    "button: Submit [disabled]",
    "button:  Submit",
    "link: Inbox [5]",
    "link: Edit [Draft]",
    "textbox: Email [required] [disabled]",
  ];
  for (const s of inputs) assert.equal(portedNormalizeKey(s), legacyNormalizeKey(s));
});

test("PARITY: normalizeRoutes matches legacy — trim, dedupe, drop absolute/interpolated", () => {
  const routes = [" /a ", "/a", "https://x.com/y", "/p/${id}", "/b"];
  assert.deepEqual(portedNormalizeRoutes(routes), legacyNormalizeRoutes(routes));
});

// ── mergeAttrs ────────────────────────────────────────────────────────────────

test("PARITY: mergeAttrs matches legacy — whitespace/state-suffix tolerant join, bracket-name collision guard", () => {
  const nodes = ["button: Submit", "link: Inbox [5]", "link: Inbox [3]", "textbox:  Username"];
  const rawAttrs = [
    { key: "button: Submit", testId: "submit-btn" },
    { key: "link: Inbox [5]", id: "inbox-unread" },
    { key: "link: Inbox [3]", id: "inbox-flagged" },
    { key: "textbox: Username", name: "username" },
    { key: "link: NonExistent", id: "never" },
  ];
  assert.deepEqual(portedMergeAttrs(nodes, rawAttrs), legacyMergeAttrs(nodes, rawAttrs));
});

// ── formatDomSnapshot (with + without changed markers, attrs, states, testIds) ──

test("PARITY: formatDomSnapshot matches legacy — attrs hint, states suffix, testIds block, node cap", () => {
  const nodes = [
    "button: Submit",
    "link: Home",
    "table: (present)",
    "textbox: Password",
    ...Array.from({ length: 65 }, (_, i) => `link: nav-${i}`),
  ];
  const snaps: PortedRouteSnapshot[] & LegacyRouteSnapshot[] = [{
    route: "/form",
    nodes,
    attrs: [
      { key: "button: Submit", testId: "submit-btn" },
      { key: "textbox: Password", id: "pwd", inputType: "password" },
    ],
    states: new Map([["button: Submit", ["disabled"]]]),
    testIds: new Map([["submit-btn", 2], ["unique-id", 1]]),
    testIdAttrName: "data-cy",
  }] as unknown as PortedRouteSnapshot[] & LegacyRouteSnapshot[];
  const changed = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  assert.equal(portedFormatDomSnapshot(snaps as PortedRouteSnapshot[], changed), legacyFormatDomSnapshot(snaps as LegacyRouteSnapshot[], changed));
  // Also without changed markers, and with a per-route capture error.
  assert.equal(portedFormatDomSnapshot(snaps as PortedRouteSnapshot[]), legacyFormatDomSnapshot(snaps as LegacyRouteSnapshot[]));
  const errored: PortedRouteSnapshot[] & LegacyRouteSnapshot[] = [{ route: "/x", error: "timeout" }] as unknown as PortedRouteSnapshot[] & LegacyRouteSnapshot[];
  assert.equal(portedFormatDomSnapshot(errored as PortedRouteSnapshot[]), legacyFormatDomSnapshot(errored as LegacyRouteSnapshot[]));
});

// ── buildChangedMarker ────────────────────────────────────────────────────────

test("PARITY: buildChangedMarker matches legacy — stable-attr priority, word-boundary text fallback, bracketed names", () => {
  const cases: Array<[string, { key: string; testId?: string; id?: string; name?: string; href?: string } | undefined, Array<{ file: string; line: number; testId?: string; id?: string; name?: string; href?: string; text?: string; raw: string }>, string?]> = [
    ["button: Submit", { key: "button: Submit", testId: "submit-btn" }, [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }]],
    ["button: Save", { key: "button: Save", id: "save-entity" }, [{ file: "f.html", line: 1, id: "save-entity", raw: "raw" }]],
    ["textbox: Username", { key: "textbox: Username", name: "username" }, [{ file: "f.html", line: 1, name: "username", raw: "raw" }]],
    ["link: Products", { key: "link: Products", href: "/products" }, [{ file: "f.html", line: 1, href: "/products", raw: "raw" }]],
    ["button: test-submission", undefined, [{ file: "", line: 0, text: "test", raw: "test" }]], // word-boundary must NOT fire
    ["button: Contact form submit", undefined, [{ file: "", line: 0, text: "form", raw: "form" }]], // whole-word DOES fire
    ["link: Inbox [5]", undefined, [{ file: "f.html", line: 1, text: "Inbox [5]", raw: "raw" }]], // bracketed name preserved
    ["button: Submit [disabled]", undefined, [{ file: "f.html", line: 1, text: "Submit", raw: "raw" }]], // ARIA state still stripped
    ["button: Cancel", { key: "button: Cancel", id: "cancel-btn" }, [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }]], // no match
    ["button: Go", { key: "button: Go", testId: "submit" }, [{ file: "", line: 0, testId: "submit", raw: "" }], "data-cy"], // configured attr name
  ];
  for (const [line, attr, changed, attrName] of cases) {
    const p = portedBuildChangedMarker(line, attr, changed, attrName);
    const l = legacyBuildChangedMarker(line, attr, changed, attrName);
    assert.equal(p, l, `mismatch for line="${line}"`);
  }
});

// ── captureDom / captureDomForRoutes / captureDomByRoute / captureRouteTrees (deps-injected) ──

test("PARITY: captureDom matches legacy — same routes extracted, same formatted output, degrade on no routes/throw", async () => {
  const render = async (_e2eDir: string, _baseUrl: string, routes: string[]) =>
    routes.map((r) => ({ route: r, nodes: [`link: Register owner`, `button: Submit`] }));
  const input = { e2eDir: "/m/e2e", baseUrl: "http://dev:8080", specContents: ['await page.goto("/#!/owners/new");'] };
  const p = await portedCaptureDom(input, { render } as PortedCaptureDomDeps);
  const l = await legacyCaptureDom(input, { render } as LegacyCaptureDomDeps);
  assert.equal(p, l);

  const degradeInput = { e2eDir: "/m", baseUrl: "http://dev", specContents: ["expect(1).toBe(1)"] };
  assert.equal(await portedCaptureDom(degradeInput, { render: async () => [] }), await legacyCaptureDom(degradeInput, { render: async () => [] }));
});

test("PARITY: captureDomForRoutes matches legacy on a testIdAttribute-forwarding, changed-marker case", async () => {
  const render = async (_e2eDir: string, _baseUrl: string, routes: string[], testIdAttribute?: string) =>
    routes.map((r) => ({ route: r, nodes: [`button: on ${r}`], testIdAttrName: testIdAttribute ?? "data-testid" }));
  const input = { e2eDir: "/e", baseUrl: "http://dev", testIdAttribute: "data-cy" };
  const p = await portedCaptureDomForRoutes(["/owners"], input, { render } as PortedCaptureDomDeps);
  const l = await legacyCaptureDomForRoutes(["/owners"], input, { render } as LegacyCaptureDomDeps);
  assert.equal(p, l);
});

test("PARITY: captureDomByRoute matches legacy — per-route map + soft-404 shared-shell drop", async () => {
  const shell = ["link: Home", "link: Owners"];
  const render = async (_e2eDir: string, _baseUrl: string, routes: string[]) =>
    routes.map((r) => ({ route: r, nodes: r === "/unique" ? ["heading: Unique", "button: Save"] : shell }));
  const input = { e2eDir: "/m", baseUrl: "http://dev" };
  const p = await portedCaptureDomByRoute(["/owners", "/vets", "/unique"], input, { render } as PortedCaptureDomDeps);
  const l = await legacyCaptureDomByRoute(["/owners", "/vets", "/unique"], input, { render } as LegacyCaptureDomDeps);
  assert.deepEqual([...p.entries()], [...l.entries()]);
});

test("PARITY: captureRouteTrees matches legacy — raw per-route nodes, testId-only route retained", async () => {
  const render = async () => [{ route: "/a", nodes: [], testIds: new Map([["x", 1]]) }];
  const input = { e2eDir: "/m", baseUrl: "http://dev", specContents: [`page.goto("/a")`] };
  const p = await portedCaptureRouteTrees(input, { render } as PortedCaptureDomDeps);
  const l = await legacyCaptureRouteTrees(input, { render } as LegacyCaptureDomDeps);
  assert.equal(p.length, l.length);
  assert.deepEqual(p.map((t) => t.route), l.map((t) => t.route));
  assert.equal(p[0]?.testIds?.get("x"), l[0]?.testIds?.get("x"));
});

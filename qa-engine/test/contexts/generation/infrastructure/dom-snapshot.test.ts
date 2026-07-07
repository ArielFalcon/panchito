import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTargetRoutes, formatDomSnapshot, parseAriaSnapshot, captureDom, captureDomByRoute, captureDomForRoutes,
  captureRouteTrees, normalizeRoutes, capDomLines, isPriorityNode, mergeAttrs, normalizeKey, parseAriaSnapshotWithState,
  buildCaptureScript,
  type CaptureDomDeps, type NodeAttr, type RouteSnapshot,
} from "@contexts/generation/infrastructure/dom-snapshot.ts";

// ── Phase 1: NodeAttr / RouteSnapshot.attrs types ───────────────────────────

test("RouteSnapshot accepts attrs?: NodeAttr[] without TS error and NodeAttr has the expected shape", () => {
  // Compile-time shape validation: constructing these values must not produce type errors.
  const attr: NodeAttr = { key: "button: Submit" };
  assert.equal(attr.key, "button: Submit");
  // Optional fields
  const full: NodeAttr = { key: "button: Submit", testId: "submit-btn", id: "save-entity", name: "submit", href: "/go" };
  assert.equal(full.testId, "submit-btn");
  assert.equal(full.id, "save-entity");
  assert.equal(full.name, "submit");
  assert.equal(full.href, "/go");

  // RouteSnapshot with attrs populated and absent are both valid shapes
  const withAttrs: RouteSnapshot = { route: "/form", nodes: ["button: Submit"], attrs: [attr] };
  assert.equal(withAttrs.attrs?.length, 1);
  const withoutAttrs: RouteSnapshot = { route: "/home", nodes: ["link: Home"] };
  assert.equal(withoutAttrs.attrs, undefined);
});

// ── Phase 2: mergeAttrs ──────────────────────────────────────────────────────

test("mergeAttrs maps RawAttr[] keyed by role:name join key; unmatched attrs are dropped", () => {
  const nodes = ["button: Submit", "link: Home", "textbox: Username"];
  const rawAttrs = [
    { key: "button: Submit", testId: "submit-btn" },
    { key: "textbox: Username", name: "username" },
    { key: "link: NonExistent", id: "never" }, // not in nodes → dropped
  ];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 2, "unmatched raw attrs are dropped");
  const btn = result.find((a) => a.key === "button: Submit");
  assert.ok(btn, "button: Submit merged");
  assert.equal(btn?.testId, "submit-btn");
  assert.equal(btn?.id, undefined);
  const txt = result.find((a) => a.key === "textbox: Username");
  assert.ok(txt, "textbox: Username merged");
  assert.equal(txt?.name, "username");
});

test("mergeAttrs([], []) returns []", () => {
  assert.deepEqual(mergeAttrs([], []), []);
});

test("mergeAttrs: collision on same key takes first occurrence", () => {
  const nodes = ["button: Submit"];
  const rawAttrs = [
    { key: "button: Submit", testId: "first" },
    { key: "button: Submit", testId: "second" },
  ];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.testId, "first", "first occurrence wins on collision");
});

test("mergeAttrs: a RawAttr with no stable attributes (no testId/id/name/href) is not emitted", () => {
  const nodes = ["button: Submit"];
  const rawAttrs = [{ key: "button: Submit" }]; // no stable attributes
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 0, "no-attr raw entries are not emitted");
});

test("extractTargetRoutes pulls app-relative routes from page.goto, dedups, normalizes a leading slash", () => {
  const spec = `
    await page.goto("/#!/owners/new");
    await page.goto('owners');                 // no leading slash → normalized
    await page.goto("/#!/owners/new");          // dup
    await page.goto("https://evil.example/x");  // absolute third-party → dropped
    await page.goto(\`/owners/\${id}\`);          // interpolated → dropped (not a stable route)
  `;
  assert.deepEqual(extractTargetRoutes([spec]), ["/#!/owners/new", "/owners"]);
});

test("extractTargetRoutes ignores .goto in commented-out lines (a disabled route is not rendered)", () => {
  const spec = `
    await page.goto("/dashboard");
    // await page.goto("/admin");          ← commented-out, must NOT be captured
    //await page.goto("/secret");
     * await page.goto("/block-comment-body"); // block-comment body line
  `;
  assert.deepEqual(extractTargetRoutes([spec]), ["/dashboard"]);
});

test("extractTargetRoutes bounds the number of routes", () => {
  const spec = ["/a", "/b", "/c", "/d", "/e", "/f"].map((r) => `page.goto("${r}")`).join("\n");
  assert.equal(extractTargetRoutes([spec], 3).length, 3);
});

// --- parseAriaSnapshot tests -------------------------------------------------
// These replace the old flattenAccessibilityTree tests. parseAriaSnapshot takes the
// YAML string returned by `locator('body').ariaSnapshot()` (PW >=1.57) and produces
// the same "role: name" output lines that formatDomSnapshot expects.

test("parseAriaSnapshot: quoted-name node emits role: name", () => {
  const yaml = `
- navigation
- link "Register owner"
- button "Submit"
- heading "Owners"
- textbox "First name"
- generic "ignored container"
`.trim();
  // Only roles in the keep-set are emitted; "generic" and nameless "navigation" are excluded.
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes("link: Register owner"), "link with quoted name");
  assert.ok(lines.includes("button: Submit"), "button with quoted name");
  assert.ok(lines.includes("heading: Owners"), "heading with quoted name");
  assert.ok(lines.includes("textbox: First name"), "textbox with quoted name");
  assert.ok(!lines.some((l) => l.startsWith("generic:")), "generic is not in keep-set");
});

// T1: an accessible name containing an escaped double-quote (PW renders `say "hi"` as
// `button "say \"hi\""`) must be captured WHOLE and unescaped — the old `"([^"]*)"` matcher
// truncated at the first `\"`, losing the rest of the name (and breaking the selector check).
test("parseAriaSnapshot: a name with an escaped double-quote is captured whole and unescaped", () => {
  const yaml = [
    String.raw`- button "say \"hi\""`,
    String.raw`- link "plain"`,
    String.raw`- heading "a \\ backslash"`,
  ].join("\n");
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes(`button: say "hi"`), `expected unescaped name, got ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("link: plain"), "the following node still parses (not consumed by the escape)");
  assert.ok(lines.includes(`heading: a \\ backslash`), "an escaped backslash is unescaped too");
});

test("parseAriaSnapshot: content-role inline value (listitem, text) is the name", () => {
  // When the role is a content role and there's a bare `: value` on the same line,
  // the value IS the accessible name (not a child block).
  const yaml = `
- listitem: Item one
- listitem: Item two
- text: Some inline text
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes("listitem: Item one"), "listitem inline value");
  assert.ok(lines.includes("listitem: Item two"), "second listitem");
  assert.ok(lines.includes("text: Some inline text"), "text inline value");
});

// S2: a NON-content kept role with a bare `: value` (e.g. `- heading: Some Text`) used to fall
// through every branch and emit nothing (→ []). Any kept role's inline value IS its name now.
test("parseAriaSnapshot: a non-content role with a bare ': value' uses the value as the name", () => {
  assert.deepEqual(parseAriaSnapshot("- heading: Some Text"), ["heading: Some Text"], "the inline heading value is the accessible name");
  // It also works for other kept non-content roles, and trailing state brackets are stripped.
  assert.deepEqual(parseAriaSnapshot("- button: Save changes"), ["button: Save changes"]);
  assert.deepEqual(parseAriaSnapshot("- heading: Owners [level=2]"), ["heading: Owners"], "state bracket stripped from inline value");
});

// A bare colon with NO value on a non-structural kept role records nothing (no name, no marker).
test("parseAriaSnapshot: a non-structural role with a bare empty colon emits nothing", () => {
  assert.deepEqual(parseAriaSnapshot("- heading:"), []);
});

test("parseAriaSnapshot: state attribute [checked] / [disabled] / [selected] does NOT become the name", () => {
  const yaml = `
- checkbox "Subscribe" [checked]
- checkbox "Newsletter" [disabled]
- option "Dog" [selected]
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes("checkbox: Subscribe"), "checkbox name without state");
  assert.ok(lines.includes("checkbox: Newsletter"), "disabled checkbox name preserved");
  assert.ok(lines.includes("option: Dog"), "option name without selected state");
  assert.ok(!lines.some((l) => l.includes("[checked]")), "state bracket not in output");
  assert.ok(!lines.some((l) => l.includes("[selected]")), "selected bracket not in output");
});

test("parseAriaSnapshot: directive lines (/url:, /options:) are skipped — no node emitted", () => {
  const yaml = `
- link "Home"
  - /url: /home
- combobox "Species"
  - /options: Dog, Cat
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes("link: Home"), "link still emitted");
  assert.ok(lines.includes("combobox: Species") || !lines.some((l) => l.startsWith("combobox:")), "combobox handling");
  assert.ok(!lines.some((l) => l.includes("/url:")), "/url directive not emitted");
  assert.ok(!lines.some((l) => l.includes("/options:")), "/options directive not emitted");
});

// TABLE/LIST roles MUST surface — their omission was the #1 selector-failure root cause.
// A real Bootstrap table with role="presentation" collapses to `- text: ...` with NO columnheader.
test("parseAriaSnapshot: presentation-table collapses to text nodes — no columnheader emitted", () => {
  // role="presentation" table: ariaSnapshot emits `- text: layout cell only` with no columnheader.
  const yaml = `
- text: layout cell only
- text: another cell
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.some((l) => l.startsWith("text:")), "text nodes from presentation table");
  assert.ok(!lines.some((l) => l.startsWith("columnheader:")), "no columnheader in presentation table");
});

test("parseAriaSnapshot: real table with columnheader exposes the role correctly", () => {
  // A real <table> with <th> exposes columnheader (the Bootstrap presentation-table does NOT).
  const yaml = `
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
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.some((l) => l.startsWith("table:")), "table: (present) emitted");
  assert.ok(lines.includes("columnheader: Name"), "columnheader Name exposed");
  assert.ok(lines.includes("columnheader: Address"), "columnheader Address exposed");
  assert.ok(lines.includes("cell: Helen Leary"), "data cells surface");
  // "radiology" appears TWICE → the author can SEE the ambiguity.
  assert.equal(lines.filter((l) => l === "cell: radiology").length, 2, "duplicate cell visible");
  // Crucially absent columnheader is not fabricated when not present:
  const colHeaderCount = lines.filter((l) => l.startsWith("columnheader:")).length;
  assert.equal(colHeaderCount, 2, "exactly 2 columnheaders from the real table");
});

test("parseAriaSnapshot: 2-space nesting is flattened — all levels emitted", () => {
  const yaml = `
- navigation
  - list
    - listitem: Home
    - listitem: Owners
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.some((l) => l.startsWith("list:")), "nested list emitted");
  assert.ok(lines.includes("listitem: Home"), "nested listitem Home");
  assert.ok(lines.includes("listitem: Owners"), "nested listitem Owners");
});

test("parseAriaSnapshot: role not in keep-set is skipped", () => {
  const yaml = `
- WebArea "PetClinic"
- generic "wrapper"
- button "Submit"
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(!lines.some((l) => l.startsWith("WebArea:")), "WebArea skipped");
  assert.ok(!lines.some((l) => l.startsWith("generic:")), "generic skipped");
  assert.ok(lines.includes("button: Submit"), "button kept");
});

test("parseAriaSnapshot: empty YAML yields empty array", () => {
  assert.deepEqual(parseAriaSnapshot(""), []);
  assert.deepEqual(parseAriaSnapshot("   \n  \n  "), []);
});

test("parseAriaSnapshot: structural roles without a name get (present) marker", () => {
  // table/grid/list/row without a quoted name → emit presence marker so the author
  // sees "there is a table here" even when it has no accessible name.
  const yaml = `
- table
  - row
    - cell "Helen"
`.trim();
  const lines = parseAriaSnapshot(yaml);
  assert.ok(lines.includes("table: (present)"), "nameless table marked present");
  assert.ok(lines.includes("row: (present)"), "nameless row marked present");
  assert.ok(lines.includes("cell: Helen"), "cell with name emitted");
});

test("parseAriaSnapshot: an UNNAMED form input surfaces as a presence marker (not dropped)", () => {
  // PetClinic-style form: `<label>First name</label><input>` where the label is NOT associated (no
  // for/id) → the input has NO accessible name. It must NOT vanish from the grounding, or the reviewer
  // sees an empty form and falsely rejects the author's selectors. Surface a presence marker so the
  // field is visible (the author then targets it by attribute/position, not a non-existent name).
  const yaml = ["- text: First name", "- textbox", "- text: Last name", "- textbox", "- combobox", '- textbox "Search"'].join("\n");
  const inputs = parseAriaSnapshot(yaml).filter((n) => n.startsWith("textbox") || n.startsWith("combobox"));
  assert.deepEqual(
    inputs,
    ["textbox: (present)", "textbox: (present)", "combobox: (present)", "textbox: Search"],
    "unnamed inputs surface as (present); a named input keeps its name",
  );
});

test("parseAriaSnapshot: table/list priority roles preserved past the formatDomSnapshot node cap", () => {
  // Build a snapshot with 80 links (over the 60-node cap) and 5 table nodes — verify the TABLE
  // nodes survive in the formatted output even though they come last in document order.
  const navLinks = Array.from({ length: 80 }, (_, i) => `- link "nav-${i}"`).join("\n");
  const tableYaml = [
    "- table",
    "  - row",
    "    - cell \"Helen Leary\"",
    "    - cell \"radiology\"",
    "  - row",
    "    - cell \"Henry Stevens\"",
    "    - cell \"radiology\"",
  ].join("\n");
  const allNodes = parseAriaSnapshot(`${navLinks}\n${tableYaml}`);
  // Build a fake RouteSnapshot from the parseAriaSnapshot output and run it through formatDomSnapshot.
  const snap = [{ route: "/vets", nodes: allNodes }];
  const out = formatDomSnapshot(snap);
  // Every table-family node must survive the cap.
  assert.ok(out.includes("  table: (present)"), "table survives cap");
  assert.ok(out.includes("  cell: Helen Leary"), "cell Helen survives cap");
  assert.equal((out.match(/cell: radiology/g) ?? []).length, 2, "duplicate radiology still visible");
  assert.match(out, /more non-table elements omitted/, "nav links are the truncated set");
});

// ── Phase 2: formatDomSnapshot with attrs ────────────────────────────────────

test("formatDomSnapshot: a node with testId appends -> [data-testid=submit] hint (default attr name)", () => {
  // testIdAttrName on RouteSnapshot carries the configured attribute name.
  // When absent, "data-testid" is the default.
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    attrs: [{ key: "button: Submit", testId: "submit" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /button: Submit\s+->\s+\[data-testid=submit\]/, "default attr name data-testid used");
});

test("formatDomSnapshot: a node with testId uses testIdAttrName from RouteSnapshot when provided", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    testIdAttrName: "data-cy",
    attrs: [{ key: "button: Submit", testId: "submit-cy" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /button: Submit.*->\s+\[data-cy=submit-cy\]/, "configured attr name appears in hint");
});

test("formatDomSnapshot: a node with only id appends -> [id=save-entity]", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Save"],
    attrs: [{ key: "button: Save", id: "save-entity" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /button: Save.*->\s+\[id=save-entity\]/, "id attr in hint");
});

test("formatDomSnapshot: a node with only name appends -> [name=username]", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["textbox: Username"],
    attrs: [{ key: "textbox: Username", name: "username" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /textbox: Username.*->\s+\[name=username\]/, "name attr in hint");
});

test("formatDomSnapshot: a (present) marker NEVER gets a hint even when attrs has a matching key", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["table: (present)", "textbox: (present)"],
    attrs: [
      { key: "table: (present)", id: "main-table" },
      { key: "textbox: (present)", testId: "search-box" },
    ],
  }];
  const out = formatDomSnapshot(snap);
  assert.ok(!out.includes("->"), "(present) markers never get an attr hint");
});

test("formatDomSnapshot: a text: marker NEVER gets a hint", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["text: Some inline content"],
    attrs: [{ key: "text: Some inline content", id: "txt1" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.ok(!out.includes("->"), "text: nodes never get an attr hint");
});

test("formatDomSnapshot: a node with no matching NodeAttr emits the line unmodified", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["link: About"],
    attrs: [{ key: "button: Other", testId: "other" }],
  }];
  const out = formatDomSnapshot(snap);
  assert.ok(out.includes("  link: About"), "unmatched node kept as-is");
  assert.ok(!out.includes("->"), "no hint for unmatched node");
});

test("formatDomSnapshot with attrs:[] is byte-identical to attrs absent", () => {
  const nodes = ["button: Submit", "link: Home", "table: (present)"];
  const withEmpty = formatDomSnapshot([{ route: "/x", nodes, attrs: [] }]);
  const withAbsent = formatDomSnapshot([{ route: "/x", nodes }]);
  assert.equal(withEmpty, withAbsent, "attrs:[] is byte-identical to attrs absent");
});

test("captureDom renders the spec's routes and formats the real DOM (the grounding the reviewer judges against)", async () => {
  const calls: { e2eDir: string; baseUrl: string; routes: string[] } = { e2eDir: "", baseUrl: "", routes: [] };
  const deps: CaptureDomDeps = {
    render: async (e2eDir, baseUrl, routes) => {
      Object.assign(calls, { e2eDir, baseUrl, routes });
      return [{ route: "/#!/owners/new", nodes: ["link: Register owner", "button: Submit"] }];
    },
  };
  const snapshot = await captureDom(
    { e2eDir: "/m/e2e", baseUrl: "http://dev:8080", specContents: ['await page.goto("/#!/owners/new");'] },
    deps,
  );
  assert.deepEqual(calls.routes, ["/#!/owners/new"]);
  assert.match(snapshot ?? "", /route \/#!\/owners\/new:/);
  assert.match(snapshot ?? "", /button: Submit/); // the REAL label — refutes a "button says Add Owner" hallucination
});

test("captureDom returns undefined (degrade, never block) when there are no routes or the render throws", async () => {
  const noRoutes = await captureDom({ e2eDir: "/m", baseUrl: "http://dev", specContents: ["expect(1).toBe(1)"] }, { render: async () => [] });
  assert.equal(noRoutes, undefined);
  const throwing: CaptureDomDeps = { render: async () => { throw new Error("browser launch failed"); } };
  const failed = await captureDom({ e2eDir: "/m", baseUrl: "http://dev", specContents: ['page.goto("/x")'] }, throwing);
  assert.equal(failed, undefined);
});

test("formatDomSnapshot surfaces a per-route capture failure instead of hiding it", () => {
  const out = formatDomSnapshot([{ route: "/x", error: "timeout" }]);
  assert.match(out, /route \/x: \(could not capture — timeout\)/);
});

// Fix 2 (audit leak 5) sub-case 5: a degraded-but-not-`error` route (empty nodes, classified
// runtimeErrors, or a redirect) must ALSO surface a warning line instead of a silent bare header —
// same spirit as the `error` case above, extended to the new degrade reasons from buildRouteCatalog.
test("formatDomSnapshot warns on a route that rendered empty (zero nodes, no capture error)", () => {
  const out = formatDomSnapshot([{ route: "/blank", nodes: [] }]);
  assert.match(out, /route \/blank:/);
  assert.match(out, /possibly broken app/, "an empty route must warn, not render a silent bare header");
});

test("formatDomSnapshot gives a runtimeErrors route an ADVISORY warning but STILL renders its nodes (grounding trusted, app-health flagged)", () => {
  const out = formatDomSnapshot([{
    route: "/owners/new",
    nodes: ["button: Submit"],
    settled: true,
    runtimeErrors: [{ type: "pageerror", text: "TypeError: undefined is not a function" }],
  }]);
  assert.match(out, /route \/owners\/new:/);
  assert.match(out, /the app logged runtime errors/, "a rendered route with runtime errors must carry the advisory heads-up");
  assert.match(out, /button: Submit/, "its nodes MUST still be rendered — the route is a trusted grounding source, only app-health is advisory");
});

test("formatDomSnapshot warns on a route degraded via a redirect (finalUrl mismatch)", () => {
  const out = formatDomSnapshot([{
    route: "/owners/new",
    nodes: ["button: Login"],
    settled: true,
    finalUrl: "http://dev.example.com/login",
  }]);
  assert.match(out, /route \/owners\/new:/);
  assert.match(out, /possibly broken app/, "a redirect-degraded route must warn");
});

test("formatDomSnapshot does NOT warn on a healthy captured route (nodes present, no runtimeErrors/redirect)", () => {
  const out = formatDomSnapshot([{ route: "/home", nodes: ["button: Submit"], settled: true }]);
  assert.doesNotMatch(out, /possibly broken app/, "a healthy route must not carry the degrade warning");
});

// The node cap MUST NOT drop the table that drives selectors. A real page sorts nav/header/links
// BEFORE the data table, so a naive head-slice truncates every cell — re-creating the "author sees
// nothing about the table" failure one layer down. Table/list roles survive past the cap.
test("formatDomSnapshot keeps table/list roles past the node cap (a present table is never truncated away)", () => {
  const nav = Array.from({ length: 80 }, (_, i) => `link: nav-${i}`); // 80 links — well over the 60 cap
  const table = ["table: (present)", "cell: Helen Leary", "cell: radiology", "cell: Henry Stevens", "cell: radiology"];
  const out = formatDomSnapshot([{ route: "/vets", nodes: [...nav, ...table] }]); // table sorts LAST
  // Every table node survives despite 80 links ahead of it.
  for (const t of table) assert.ok(out.includes(`  ${t}`), `table node dropped by the cap: ${t}`);
  // And the duplicate "radiology" is still visible twice (the strict-mode-ambiguity signal).
  assert.equal((out.match(/cell: radiology/g) ?? []).length, 2);
  assert.match(out, /more non-table elements omitted/); // the dropped ones are nav links, not the table
});

// S1: a Bootstrap role="presentation" table COLLAPSES to `- text:` nodes with NO columnheader — that
// `text:` line IS the collapse signal the feature surfaces (it tells the author "no columnheader
// here"). `text` was in the parse keep-set but NOT in PRIORITY_ROLES, so capDomLines could truncate it
// away behind a wall of nav links — destroying the very signal. `text` is now a priority role.
test("S1: text is a priority node (the Bootstrap-collapse signal survives the cap)", () => {
  assert.ok(isPriorityNode("text: layout cell only"), "a text: node must be treated as priority");
  // Direct capDomLines: 80 links + 2 collapse text nodes, cap 60 → both text nodes must survive.
  const links = Array.from({ length: 80 }, (_, i) => `link: nav-${i}`);
  const textNodes = ["text: First Last Address", "text: Helen Leary 638 Cardinal"]; // presentation-table cells
  const { kept } = capDomLines([...links, ...textNodes], 60);
  for (const t of textNodes) assert.ok(kept.includes(t), `text collapse node dropped by the cap: ${t}`);
});

test("S1: formatDomSnapshot keeps text: collapse nodes past the node cap (they sort after the nav)", () => {
  const nav = Array.from({ length: 80 }, (_, i) => `link: nav-${i}`); // 80 links — over the 60 cap
  const collapse = ["text: First Last City", "text: George Franklin 110 W. Liberty"]; // presentation-table text
  const out = formatDomSnapshot([{ route: "/vets", nodes: [...nav, ...collapse] }]); // text sorts LAST
  for (const t of collapse) assert.ok(out.includes(`  ${t}`), `text collapse node dropped by the cap: ${t}`);
  assert.match(out, /more non-table elements omitted/); // the dropped ones are nav links, not the text signal
});

// ── captureDomByRoute: per-objective grounding split + soft-404 guard (F1) ─────
test("normalizeRoutes trims, drops absolute/interpolated URLs, and dedupes", () => {
  assert.deepEqual(
    normalizeRoutes([" /a ", "/a", "https://x.com/y", "/p/${id}", "/b"]),
    ["/a", "/b"],
  );
});

test("captureDomByRoute returns a per-route map keyed by the requested route", async () => {
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, routes) => routes.map((r) => ({ route: r, nodes: [`button: on ${r}`] })),
  };
  const map = await captureDomByRoute(["/a", "/b"], { e2eDir: "/m", baseUrl: "http://dev" }, deps);
  assert.equal(map.size, 2, "one entry per distinct route");
  assert.match(map.get("/a") ?? "", /route \/a:/);
  assert.match(map.get("/a") ?? "", /button: on \/a/);
  assert.match(map.get("/b") ?? "", /button: on \/b/);
});

test("captureDomByRoute drops shell-collision routes (soft-404: identical node sets across routes)", async () => {
  // A hash-routed SPA answers every path with the same shell DOM → /owners and /vets collide; only
  // the genuinely distinct route survives (the colliding ones degrade to the strong agent upstream).
  const shell = ["link: Home", "link: Owners"];
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, routes) =>
      routes.map((r) => ({ route: r, nodes: r === "/unique" ? ["heading: Unique", "button: Save"] : shell })),
  };
  const map = await captureDomByRoute(["/owners", "/vets", "/unique"], { e2eDir: "/m", baseUrl: "http://dev" }, deps);
  assert.equal(map.size, 1, "only the unique snapshot is kept");
  assert.ok(map.has("/unique"), "the route-specific snapshot survives");
  assert.ok(!map.has("/owners") && !map.has("/vets"), "shared-shell routes (a 2/3 majority) are dropped");
});

test("captureDomByRoute does NOT drop a NON-majority coincidental match (avoids the soft-404 false positive)", async () => {
  // 4 routes: /a and /b coincidentally share interactive chrome (count 2 — NOT a majority of 4); /c and
  // /d are unique. The majority rule (count > routes/2) must keep all four — two similar real pages are
  // not a shell, and dropping them would needlessly flood the (bounded) strong-agent fallback.
  const shared = ["button: Save", "link: Back"];
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, routes) =>
      routes.map((r) => ({ route: r, nodes: r === "/a" || r === "/b" ? shared : [`heading: ${r}`] })),
  };
  const map = await captureDomByRoute(["/a", "/b", "/c", "/d"], { e2eDir: "/m", baseUrl: "http://dev" }, deps);
  assert.equal(map.size, 4, "a non-majority collision is not treated as a shell — all routes kept");
});

test("captureDomByRoute degrades to an empty map (no routes / no baseUrl / render throws / errored route)", async () => {
  const ok: CaptureDomDeps = { render: async (_e2eDir, _baseUrl, routes) => routes.map((r) => ({ route: r, nodes: ["button: x"] })) };
  assert.equal((await captureDomByRoute([], { e2eDir: "/m", baseUrl: "http://dev" }, ok)).size, 0, "no routes → empty");
  assert.equal((await captureDomByRoute(["/a"], { e2eDir: "/m", baseUrl: undefined }, ok)).size, 0, "no baseUrl → empty");
  const throwing: CaptureDomDeps = { render: async () => { throw new Error("browser launch failed"); } };
  assert.equal((await captureDomByRoute(["/a"], { e2eDir: "/m", baseUrl: "http://dev" }, throwing)).size, 0, "render throws → empty");
  const errored: CaptureDomDeps = { render: async () => [{ route: "/a", error: "nav failed" }] };
  assert.equal((await captureDomByRoute(["/a"], { e2eDir: "/m", baseUrl: "http://dev" }, errored)).size, 0, "errored route excluded");
});

// ── captureRouteTrees: per-route RAW node lines for the pre-execution selector check (W1) ──────

test("captureRouteTrees returns RouteSnapshot[] with raw nodes for the spec's target routes", async () => {
  const spec = `await page.goto("/#!/owners"); await page.goto("/#!/vets");`;
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, routes) => routes.map((r) => ({ route: r, nodes: [`heading: ${r}`] })),
  };
  const trees = await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [spec] }, deps);
  assert.deepEqual(
    trees.map((t) => t.route),
    ["/#!/owners", "/#!/vets"],
  );
  assert.deepEqual(trees[0]!.nodes, ["heading: /#!/owners"]);
});

test("captureRouteTrees does NOT apply the shared-shell dedup (the shell IS the DOM to check for ambiguity)", async () => {
  // Two hash routes serving an IDENTICAL shell — captureDomByRoute would DROP these, but the
  // pre-execution ambiguity check must see the real rendered tree regardless of framework/routing.
  const spec = `await page.goto("/#!/a"); await page.goto("/#!/b");`;
  const deps: CaptureDomDeps = {
    render: async (_e2eDir, _baseUrl, routes) => routes.map((r) => ({ route: r, nodes: ["heading: Owners", "heading: Owners"] })),
  };
  const trees = await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [spec] }, deps);
  assert.equal(trees.length, 2, "shared shell is kept, not deduped");
  assert.deepEqual(trees[0]!.nodes, ["heading: Owners", "heading: Owners"]);
});

test("captureRouteTrees is best-effort: no routes / no baseUrl / render throws / errored or empty nodes → []", async () => {
  const ok: CaptureDomDeps = { render: async (_e, _b, routes) => routes.map((r) => ({ route: r, nodes: ["button: x"] })) };
  assert.deepEqual(await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: ["expect(1).toBe(1)"] }, ok), [], "no goto routes → []");
  assert.deepEqual(await captureRouteTrees({ e2eDir: "/m", baseUrl: "", specContents: [`page.goto("/a")`] }, ok), [], "no baseUrl → []");
  const throwing: CaptureDomDeps = { render: async () => { throw new Error("launch failed"); } };
  assert.deepEqual(await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [`page.goto("/a")`] }, throwing), [], "render throws → []");
  const errored: CaptureDomDeps = { render: async () => [{ route: "/a", error: "nav failed" }, { route: "/b", nodes: [] }] };
  assert.deepEqual(await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [`page.goto("/a"); page.goto("/b")`] }, errored), [], "errored + empty-nodes(-and-no-testIds) excluded");
});

// JD fix: a page built entirely from role-less test-id elements (<div data-cy=x> with no ARIA role) has
// EMPTY nodes[] but a populated testIds index — exactly what the role-independent capture exists to add
// value on. It must NOT be dropped by the nodes-only filter, or the catalog gate goes blind to it.
test("captureRouteTrees keeps a route with testIds even when its ARIA nodes are empty (role-less test-id page)", async () => {
  const deps: CaptureDomDeps = { render: async () => [{ route: "/a", nodes: [], testIds: new Map([["x", 1]]) }] };
  const trees = await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [`page.goto("/a")`] }, deps);
  assert.equal(trees.length, 1, "a testId-only route is not dropped");
  assert.equal(trees[0]!.testIds?.get("x"), 1);
});

// ── Phase 2 (Slice 1): buildChangedMarker + formatDomSnapshot(snaps, changed?) ─────────────────

// Import the new exports. These will fail until Task 2.2 is implemented.
import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";
import { buildChangedMarker } from "@contexts/generation/infrastructure/dom-snapshot.ts";

// (a) node with testId matching a ChangedElement.testId → line ends with [CHANGED: …]
test("buildChangedMarker: matches on testId → returns [CHANGED: added data-cy=…]", () => {
  const attr: NodeAttr = { key: "button: Submit", testId: "submit-btn" };
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  const marker = buildChangedMarker("button: Submit", attr, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "marker starts with [CHANGED:");
  assert.ok(marker.includes("submit-btn"), "marker includes the testId value");
});

// (b) match by id
test("buildChangedMarker: matches on id → returns [CHANGED: added id=…]", () => {
  const attr: NodeAttr = { key: "button: Save", id: "save-entity" };
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, id: "save-entity", raw: "raw" }];
  const marker = buildChangedMarker("button: Save", attr, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "marker for id match");
  assert.ok(marker.includes("save-entity"), "marker includes id value");
});

// (c) match by name
test("buildChangedMarker: matches on name → returns [CHANGED: added name=…]", () => {
  const attr: NodeAttr = { key: "textbox: Username", name: "username" };
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, name: "username", raw: "raw" }];
  const marker = buildChangedMarker("textbox: Username", attr, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "marker for name match");
  assert.ok(marker.includes("username"), "marker includes name value");
});

// (d) match by href
test("buildChangedMarker: matches on href → returns [CHANGED: new link → /path]", () => {
  const attr: NodeAttr = { key: "link: Products", href: "/products" };
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, href: "/products", raw: "raw" }];
  const marker = buildChangedMarker("link: Products", attr, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "marker for href match");
  assert.ok(marker.includes("/products"), "marker includes href value");
});

// (e) text-fallback match (role:name segment equals changed.text)
test("buildChangedMarker: text fallback — node name contains changed.text → [CHANGED: added text …]", () => {
  const attr: NodeAttr | undefined = undefined; // no stable attrs
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, text: "Submit", raw: "raw" }];
  const marker = buildChangedMarker("button: Submit", attr, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "text fallback match produces marker");
  assert.ok(marker.includes("Submit"), "marker includes the text");
});

// (f) no match → empty string (line byte-identical to today's formatDomSnapshot output)
test("buildChangedMarker: no match → returns empty string", () => {
  const attr: NodeAttr = { key: "button: Cancel", id: "cancel-btn" };
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }]; // different testId
  const marker = buildChangedMarker("button: Cancel", attr, changed);
  assert.equal(marker, "", "no match → empty string");
});

// (g) changed=undefined → entire output byte-identical to formatDomSnapshot(snaps) (regression guard)
test("formatDomSnapshot: changed=undefined → output byte-identical to one-arg call (regression guard)", () => {
  const snaps: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit", "link: Home"],
    attrs: [{ key: "button: Submit", testId: "submit" }],
  }];
  const withoutArg = formatDomSnapshot(snaps);
  const withUndefined = formatDomSnapshot(snaps, undefined);
  assert.equal(withUndefined, withoutArg, "passing undefined is byte-identical to omitting the arg");
});

// (h) changed=[] → byte-identical (regression guard)
test("formatDomSnapshot: changed=[] → output byte-identical to one-arg call (regression guard)", () => {
  const snaps: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit", "link: Home"],
    attrs: [{ key: "button: Submit", testId: "submit" }],
  }];
  const withoutArg = formatDomSnapshot(snaps);
  const withEmpty = formatDomSnapshot(snaps, []);
  assert.equal(withEmpty, withoutArg, "empty changed array is byte-identical to omitting the arg");
});

// (i) marker NEVER appears in nodes[] — call parseAriaSnapshot on the same fixture
test("formatDomSnapshot with changed: marker appears in formatted string but NEVER in nodes[]", () => {
  const yaml = "- button \"Submit\"";
  const nodes = parseAriaSnapshot(yaml);
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, text: "Submit", raw: "raw" }];
  const snap: RouteSnapshot[] = [{ route: "/form", nodes }];
  const formatted = formatDomSnapshot(snap, changed);
  // Formatted output contains the marker
  assert.ok(formatted.includes("[CHANGED:"), "marker appears in formatted string");
  // nodes[] are UNCHANGED — no marker in the raw nodes array
  for (const n of nodes) {
    assert.ok(!n.includes("[CHANGED:"), `nodes[] must be unchanged: "${n}"`);
  }
  // And the snap.nodes[] is the SAME object — not modified
  assert.ok(!snap[0]!.nodes!.some((n) => n.includes("[CHANGED:")), "snap.nodes[] not mutated");
});

// Full integration: formatDomSnapshot with changed entries produces [CHANGED] on matched lines
test("formatDomSnapshot with matched changed entry: marker appended after -> [attr] hint", () => {
  const snaps: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    attrs: [{ key: "button: Submit", testId: "submit-btn" }],
  }];
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  const out = formatDomSnapshot(snaps, changed);
  // Must contain the attr hint
  assert.ok(out.includes("->"), "attr hint present");
  // Must contain the CHANGED marker
  assert.ok(out.includes("[CHANGED:"), "CHANGED marker present");
  // Marker appears on the same line as the node
  const lines = out.split("\n");
  const nodeLine = lines.find((l) => l.includes("button: Submit"));
  assert.ok(nodeLine, "node line found");
  assert.ok(nodeLine!.includes("[CHANGED:"), "marker on the same line as the node");
});

// Unmatched node lines are byte-identical when changed is provided
test("formatDomSnapshot: unmatched node → line unchanged even when changed is non-empty", () => {
  const snaps: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit", "link: About"],
    attrs: [{ key: "button: Submit", testId: "submit-btn" }],
  }];
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  const withChanged = formatDomSnapshot(snaps, changed);
  const withoutChanged = formatDomSnapshot(snaps);
  // The "link: About" line must be identical in both
  const withChangedLines = withChanged.split("\n");
  const withoutLines = withoutChanged.split("\n");
  const aboutWith = withChangedLines.find((l) => l.includes("link: About"));
  const aboutWithout = withoutLines.find((l) => l.includes("link: About"));
  assert.equal(aboutWith, aboutWithout, "unmatched node line is byte-identical");
});

// ── Fix 1b: word-boundary in buildChangedMarker text-FALLBACK only ────────────
// RED tests: the text fallback MUST NOT fire on substring-of-word matches.
// These fail against the current impl ("test" matches "test-submission" via .includes).
// The stable-attr path (testId/id/name/href) is UNCHANGED and must still work as before.

test("buildChangedMarker FIX-1b: text fallback must NOT fire when changed.text is a substring-of-word in nodeName", () => {
  // "test" appears as the PREFIX of "test-submission", not as a whole word.
  // The marker must NOT fire — substring match would mislead the agent.
  const changed: ChangedElement[] = [{ file: "", line: 0, text: "test", raw: "test" }];
  const marker = buildChangedMarker("button: test-submission", undefined, changed);
  assert.equal(marker, "", "'test' must not match 'test-submission' via substring — word boundary required");
});

test("buildChangedMarker FIX-1b: text fallback must NOT fire when changed.text is 'form' matching 'Contact form submit'", () => {
  // The manual-mode guidance "test the contact form" emits c.text="form".
  // Node name "Contact form submit" DOES contain "form" as a whole word.
  // After the fix this SHOULD match (it's a whole word in the name).
  // But the false-positive was "test" matching "test-submission"; this is separate.
  // Here we test that a partial-word that is NOT a word boundary does not fire.
  const changed: ChangedElement[] = [{ file: "", line: 0, text: "sub", raw: "sub" }];
  const marker = buildChangedMarker("button: test-submission", undefined, changed);
  assert.equal(marker, "", "'sub' must not match 'test-submission' as a non-word-boundary token");
});

test("buildChangedMarker FIX-1b: text fallback DOES fire when changed.text is an EXACT whole-word match in nodeName", () => {
  // "form" as a whole word inside "Contact form submit" — should produce a marker
  const changed: ChangedElement[] = [{ file: "", line: 0, text: "form", raw: "form" }];
  const marker = buildChangedMarker("button: Contact form submit", undefined, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "whole-word 'form' in 'Contact form submit' must match");
});

test("buildChangedMarker FIX-1b: text fallback DOES fire when node name equals changed.text exactly", () => {
  // Node name IS the phrase — always a match
  const changed: ChangedElement[] = [{ file: "", line: 0, text: "Submit", raw: "Submit" }];
  const marker = buildChangedMarker("button: Submit", undefined, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "exact-equality match must still produce a marker");
});

test("buildChangedMarker FIX-1b: DIFF-mode stable-attr path (testId/id/name/href) is UNAFFECTED by word-boundary fix", () => {
  // Stable-attr matches never used the text fallback — they must be byte-identical after the fix
  const attrTestId: NodeAttr = { key: "button: Submit", testId: "submit-btn" };
  const changedById: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  assert.ok(buildChangedMarker("button: Submit", attrTestId, changedById).includes("submit-btn"), "testId match unchanged");

  const attrId: NodeAttr = { key: "button: Save", id: "save-entity" };
  const changedByIdAttr: ChangedElement[] = [{ file: "f.html", line: 1, id: "save-entity", raw: "raw" }];
  assert.ok(buildChangedMarker("button: Save", attrId, changedByIdAttr).includes("save-entity"), "id match unchanged");

  const attrHref: NodeAttr = { key: "link: Products", href: "/products" };
  const changedByHref: ChangedElement[] = [{ file: "f.html", line: 1, href: "/products", raw: "raw" }];
  assert.ok(buildChangedMarker("link: Products", attrHref, changedByHref).includes("/products"), "href match unchanged");
});

// Full scenario from verify report WARNING-2: guidance "test the contact form" emitting
// text entries MUST NOT produce markers on unrelated nodes when stopwords are filtered
// and the text fallback uses word boundaries.
test("FIX-1 end-to-end: guidance 'test the contact form' must NOT mark test-submission or form-details nodes", async () => {
  const { DiffParserService } = await import("@kernel/diff-parser/diff-parser.service.ts");
  const changed = new DiffParserService().changedElementsFromGuidance("test the contact form");
  const nodes = ["button: test-submission", "button: Contact form submit", "link: form-details"];
  for (const node of nodes) {
    const marker = buildChangedMarker(node, undefined, changed);
    // "button: test-submission" — 'test' is a stopword OR fails word-boundary; must NOT match
    // "link: form-details" — 'form' appears as prefix of "form-details"; must NOT match
    // "button: Contact form submit" — 'contact' or 'form' as whole words; this one MAY match
    // (the test just ensures NO spurious markers on the clearly wrong nodes)
    if (node === "button: test-submission" || node === "link: form-details") {
      assert.equal(marker, "", `guidance must NOT spuriously mark "${node}": got "${marker}"`);
    }
  }
});

// ── REGRESSION GUARD: buildChangedMarker text-fallback with real bracketed accessible names ──
// The text-fallback strip on rawNodeName must NOT use a generic /\s*\[[^\]]*\]\s*$/ pattern.
// Real accessible names ending in brackets (badge counts "Inbox [5]", draft markers "Edit [Draft]")
// must be preserved so the word/exact match in the text fallback fires correctly.
//
// RED: these FAIL against the current generic strip because rawNodeName "Inbox [5]" becomes
// "Inbox", then c.text "Inbox [5]" does NOT equal "inbox" and "inbox [5]" not in ["inbox"].
// GREEN: requires narrowing to the ARIA-state allowlist (same pattern as selector-check.ts).

test("REGRESSION: buildChangedMarker text-fallback correctly matches node whose name ends in brackets (badge count)", () => {
  // Node "link: Inbox [5]" — accessible name is literally "Inbox [5]" (badge count).
  // changed.text is also "Inbox [5]". The text fallback must fire: exact equality match.
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, text: "Inbox [5]", raw: "raw" }];
  const marker = buildChangedMarker("link: Inbox [5]", undefined, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "text fallback must fire: 'Inbox [5]' should match changed.text 'Inbox [5]'");
});

test("REGRESSION: buildChangedMarker text-fallback correctly matches node whose name ends in draft marker", () => {
  // Node "link: Edit [Draft]" — accessible name is literally "Edit [Draft]".
  // changed.text is "Edit [Draft]". The text fallback must fire.
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, text: "Edit [Draft]", raw: "raw" }];
  const marker = buildChangedMarker("link: Edit [Draft]", undefined, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "text fallback must fire: 'Edit [Draft]' should match changed.text 'Edit [Draft]'");
});

test("REGRESSION: buildChangedMarker text-fallback still strips ARIA state tokens (allowlist positive case)", () => {
  // Node "button: Submit [disabled]" — [disabled] IS an ARIA state token → strip it → name is "Submit".
  // changed.text is "Submit". Exact equality match must still fire.
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, text: "Submit", raw: "raw" }];
  const marker = buildChangedMarker("button: Submit [disabled]", undefined, changed);
  assert.ok(marker.startsWith(" [CHANGED:"), "[disabled] is an ARIA state token — must be stripped so 'Submit' exact-matches changed.text");
});

// ── Slice 3: dom-capture-completeness ─────────────────────────────────────────
// RED tests written BEFORE implementation per strict TDD mode.
// Task 4.1 — GATE DELTA 1: interactive-priority budget protection

// Task 4.1 RED: capDomLines must NOT evict interactive nodes in favor of landmarks.
// 5 landmark + 55 interactive = 60 nodes, MAX=60 → every interactive node kept.
// Today FAILS because landmarks fill otherBudget in document order before buttons.
test("4.1 [RED→GREEN] capDomLines: interactive nodes are NOT evicted for landmarks when budget is tight", () => {
  const landmarks = Array.from({ length: 5 }, (_, i) => `navigation: nav-${i}`);
  const interactive = Array.from({ length: 55 }, (_, i) => `button: btn-${i}`);
  // Document order: landmarks first, then interactive (worst case for current impl)
  const lines = [...landmarks, ...interactive];
  const { kept, dropped } = capDomLines(lines, 60);
  // ALL 55 interactive nodes must survive — none evicted for landmarks
  for (let i = 0; i < 55; i++) {
    assert.ok(kept.includes(`button: btn-${i}`), `button btn-${i} must NOT be evicted`);
  }
  // Some landmarks may be dropped (budget is tight) but interactive nodes are safe
  assert.equal(dropped, 0, "total nodes = cap, nothing should be dropped");
});

test("4.1b [RED→GREEN] capDomLines: interactive nodes survive when landmarks would fill otherBudget", () => {
  // 10 landmarks + 60 interactive nodes, cap=60; priority (table/list) = 0
  // Old impl: otherBudget=60, landmarks fill first 10, interactive fills 50 → 10 interactive evicted
  // New impl: interactive tier fills before landmarks → all 60 interactive kept, landmarks dropped
  const landmarks = Array.from({ length: 10 }, (_, i) => `navigation: nav-${i}`);
  const interactive = Array.from({ length: 60 }, (_, i) => `button: btn-${i}`);
  const lines = [...landmarks, ...interactive];
  const { kept } = capDomLines(lines, 60);
  for (let i = 0; i < 60; i++) {
    assert.ok(kept.includes(`button: btn-${i}`), `interactive button btn-${i} must not be evicted`);
  }
  // Landmarks may be dropped since budget is full after interactive
  const keptLandmarks = kept.filter((l) => l.startsWith("navigation:"));
  assert.equal(keptLandmarks.length, 0, "landmarks should be evicted to make room for interactive nodes");
});

// Task 4.2 RED: bare nodes[] invariant — parseAriaSnapshot must NOT include state suffix.
// The invariant already holds today, but we write an EXPLICIT assertion to lock it.
test("4.2 [RED→GREEN] parseAriaSnapshot: state suffix [disabled] NEVER appears in nodes[] output", () => {
  const result = parseAriaSnapshot('- button "Submit" [disabled]');
  assert.deepEqual(result, ["button: Submit"], `nodes[] must be bare; got ${JSON.stringify(result)}`);
  assert.ok(!result.some((l) => l.includes("[disabled]")), "no state suffix in nodes[]");
  assert.ok(!result.some((l) => l.includes("[checked]")), "no [checked] in nodes[]");
});

// Task 4.3 RED: parseAriaSnapshotWithState state capture (parallel structure)
test("4.3 [RED→GREEN] parseAriaSnapshotWithState: nodes stay bare, states captured in parallel map", () => {
  const { nodes, states } = parseAriaSnapshotWithState(
    '- button "Submit" [disabled]\n- checkbox "Remember me" [checked]'
  );
  assert.deepEqual(nodes, ["button: Submit", "checkbox: Remember me"], "nodes[] must be bare");
  assert.deepEqual(states.get("button: Submit"), ["disabled"], "disabled state captured");
  assert.deepEqual(states.get("checkbox: Remember me"), ["checked"], "checked state captured");
});

test("4.3b parseAriaSnapshotWithState: multiple states on same node all captured", () => {
  const { nodes, states } = parseAriaSnapshotWithState('- textbox "Email" [required] [disabled]');
  assert.deepEqual(nodes, ["textbox: Email"], "bare node");
  const s = states.get("textbox: Email");
  assert.ok(s?.includes("required"), "required captured");
  assert.ok(s?.includes("disabled"), "disabled captured");
});

test("4.3c parseAriaSnapshotWithState: no state → key absent from map (not empty array)", () => {
  const { nodes, states } = parseAriaSnapshotWithState('- button "Save"');
  assert.deepEqual(nodes, ["button: Save"]);
  assert.equal(states.get("button: Save"), undefined, "no state → absent from map");
});

// Task 4.4 RED: formatDomSnapshot renders state suffix DISPLAY-ONLY (not in nodes[])
test("4.4 [RED→GREEN] formatDomSnapshot: state suffix appears in formatted output when states map provided", () => {
  const statesMap = new Map([["button: Submit", ["disabled"]]]);
  const snap: RouteSnapshot[] = [{ route: "/form", nodes: ["button: Submit"], states: statesMap }];
  const out = formatDomSnapshot(snap);
  assert.ok(out.includes("button: Submit [disabled]"), `state suffix should appear in formatted output; got: ${out}`);
  // Crucially: nodes[] is still bare
  assert.deepEqual(snap[0]!.nodes, ["button: Submit"], "nodes[] must remain bare");
});

test("4.4b formatDomSnapshot: state NEVER appears on (present) marker lines", () => {
  const statesMap = new Map([["form: (present)", ["disabled"]]]);
  const snap: RouteSnapshot[] = [{ route: "/form", nodes: ["form: (present)"], states: statesMap }];
  const out = formatDomSnapshot(snap);
  // State should NOT appear on marker lines
  const formLine = out.split("\n").find((l) => l.includes("form:"));
  assert.ok(formLine, "form line exists");
  assert.ok(!formLine!.includes("[disabled]"), "state not on (present) marker line");
});

test("4.4c formatDomSnapshot: state suffix appears BEFORE [CHANGED:] marker in output", () => {
  const statesMap = new Map([["button: Submit", ["disabled"]]]);
  const snaps: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    attrs: [{ key: "button: Submit", testId: "submit-btn" }],
    states: statesMap,
  }];
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "submit-btn", raw: "raw" }];
  const out = formatDomSnapshot(snaps, changed);
  const nodeLine = out.split("\n").find((l) => l.includes("button: Submit"));
  assert.ok(nodeLine, "node line found");
  // state suffix BEFORE CHANGED marker
  const stateIdx = nodeLine!.indexOf("[disabled]");
  const changedIdx = nodeLine!.indexOf("[CHANGED:");
  assert.ok(stateIdx !== -1, "state suffix present");
  assert.ok(changedIdx !== -1, "CHANGED marker present");
  assert.ok(stateIdx < changedIdx, "state suffix appears before CHANGED marker");
});

// Task 4.5 RED: seam B keep-set expansion
test("4.5 [RED→GREEN] parseAriaSnapshot: expanded keep-set — dialog, form, navigation, switch", () => {
  assert.ok(parseAriaSnapshot('- dialog "Confirm Delete"').includes("dialog: Confirm Delete"), "dialog with name");
  assert.ok(parseAriaSnapshot("- form:").includes("form: (present)"), "unnamed form → (present)");
  assert.ok(parseAriaSnapshot('- navigation "Main"').includes("navigation: Main"), "navigation with name");
  assert.ok(parseAriaSnapshot('- switch "Dark mode"').includes("switch: Dark mode"), "switch kept");
});

test("4.5b parseAriaSnapshot: alertdialog, alert, status, banner, main, progressbar all kept", () => {
  assert.ok(parseAriaSnapshot('- alertdialog "Danger!"').includes("alertdialog: Danger!"), "alertdialog");
  assert.ok(parseAriaSnapshot('- alert "Error occurred"').includes("alert: Error occurred"), "alert");
  assert.ok(parseAriaSnapshot('- status "Loading"').includes("status: Loading"), "status");
  assert.ok(parseAriaSnapshot('- banner "Site header"').includes("banner: Site header"), "banner");
  assert.ok(parseAriaSnapshot('- main "Content"').includes("main: Content"), "main");
  assert.ok(parseAriaSnapshot('- progressbar "Upload progress"').includes("progressbar: Upload progress"), "progressbar");
});

test("4.5c parseAriaSnapshot: dialog/alertdialog/form/navigation/banner/main/switch are STRUCTURAL (unnamed → (present))", () => {
  assert.deepEqual(parseAriaSnapshot("- dialog:"), ["dialog: (present)"], "unnamed dialog → (present)");
  assert.deepEqual(parseAriaSnapshot("- alertdialog:"), ["alertdialog: (present)"], "unnamed alertdialog → (present)");
  assert.deepEqual(parseAriaSnapshot("- form:"), ["form: (present)"], "unnamed form → (present)");
  assert.deepEqual(parseAriaSnapshot("- navigation:"), ["navigation: (present)"], "unnamed navigation → (present)");
  assert.deepEqual(parseAriaSnapshot("- banner:"), ["banner: (present)"], "unnamed banner → (present)");
  assert.deepEqual(parseAriaSnapshot("- main:"), ["main: (present)"], "unnamed main → (present)");
  assert.deepEqual(parseAriaSnapshot("- switch:"), ["switch: (present)"], "unnamed switch → (present) (Delta 4)");
});

test("4.5d parseAriaSnapshot: alert/status/progressbar NOT structural — unnamed instances dropped", () => {
  // alert, status, progressbar are NOT structural → unnamed instance is dropped (not kept as (present))
  assert.deepEqual(parseAriaSnapshot("- alert:"), [], "unnamed alert dropped (not structural)");
  assert.deepEqual(parseAriaSnapshot("- status:"), [], "unnamed status dropped (not structural)");
  assert.deepEqual(parseAriaSnapshot("- progressbar:"), [], "unnamed progressbar dropped (not structural)");
});

// Task 4.6 RED: seam C inputType + nameFallback propagation
test("4.6 [RED→GREEN] mergeAttrs: inputType propagated from RawAttr to NodeAttr", () => {
  const nodes = ["textbox: (present)"];
  const rawAttrs = [{ key: "textbox: (present)", inputType: "password", id: "pwd" }];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 1, "entry emitted");
  assert.equal(result[0]?.inputType, "password", "inputType propagated");
  assert.equal(result[0]?.id, "pwd", "id still present");
});

test("4.6b mergeAttrs: nameFallback propagated from RawAttr to NodeAttr", () => {
  const nodes = ["textbox: (present)"];
  const rawAttrs = [{ key: "textbox: (present)", nameFallback: "Search…", id: "search" }];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result[0]?.nameFallback, "Search…", "nameFallback propagated");
});

test("4.6c buildAttrHint: inputType appears in hint after stable attrs on a NAMED node", () => {
  // We test via formatDomSnapshot since buildAttrHint is not exported.
  // A NAMED input node with id + inputType → hint contains both.
  // Note: (present) structural markers correctly receive NO hint per the existing invariant.
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["textbox: Password"],
    attrs: [{ key: "textbox: Password", id: "pwd", inputType: "password" }],
    states: new Map(),
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /id=pwd/, "id in hint");
  assert.match(out, /type=password/, "inputType in hint as type=");
});

test("4.6d buildAttrHint: nameFallback appears in hint on a named node", () => {
  // nameFallback is captured by the in-page walk for unnamed inputs. Here we test that
  // if a named node also has a fallback, it appears in the hint. The (present) marker
  // invariant remains: (present) lines never get a hint. This tests the buildAttrHint logic
  // via a node that mergeAttrs produces with a key that is NOT a (present) marker.
  const snap: RouteSnapshot[] = [{
    route: "/search",
    nodes: ["textbox: Search"],
    attrs: [{ key: "textbox: Search", nameFallback: "Search…" }],
    states: new Map(),
  }];
  const out = formatDomSnapshot(snap);
  assert.match(out, /Search…/, "nameFallback appears in hint");
});

test("4.6e buildAttrHint: absent inputType and nameFallback produce no extra tokens (byte-identical hint)", () => {
  // A node with only id → hint is exactly [id=save-entity], no extra tokens
  const snap1: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Save"],
    attrs: [{ key: "button: Save", id: "save-entity" }],
  }];
  const snap2: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Save"],
    attrs: [{ key: "button: Save", id: "save-entity" }],
    states: new Map(),
  }];
  const out1 = formatDomSnapshot(snap1);
  const out2 = formatDomSnapshot(snap2);
  // Both should have [id=save-entity] and no extra tokens
  assert.match(out1, /\[id=save-entity\]/);
  assert.match(out2, /\[id=save-entity\]/);
  assert.ok(!out1.includes("type="), "no type= token when inputType absent");
  assert.ok(!out2.includes("type="), "no type= token when inputType absent (with empty states)");
});

// Task 4.7 RED: seam D normalizeKey and mergeAttrs hardening
test("4.7 [RED→GREEN] normalizeKey: strips trailing [...] then collapses whitespace", () => {
  assert.equal(normalizeKey("button: Submit [disabled]"), "button: Submit", "trailing state stripped");
  assert.equal(normalizeKey("button:  Submit"), "button: Submit", "double space collapsed");
  assert.equal(normalizeKey("  button: Submit  "), "button: Submit", "leading/trailing trimmed");
  assert.equal(normalizeKey("button: Submit"), "button: Submit", "already normalized → unchanged");
});

test("4.7b mergeAttrs: whitespace divergence does NOT drop attrs (double space after colon)", () => {
  // nodes[] has double-space, RawAttr has single-space key
  const nodes = ["button:  Submit"];
  const rawAttrs = [{ key: "button: Submit", id: "btn" }];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 1, "NodeAttr emitted despite whitespace divergence");
  assert.equal(result[0]?.id, "btn");
});

test("4.7c mergeAttrs: state suffix on node key does NOT prevent attr merge", () => {
  // nodes[] has state suffix (from seam A), RawAttr has bare key
  const nodes = ["button: Submit [disabled]"];
  const rawAttrs = [{ key: "button: Submit", id: "btn" }];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 1, "NodeAttr emitted despite state suffix on node key");
  assert.equal(result[0]?.key, "button: Submit", "NodeAttr.key is the bare normalized key");
  assert.equal(result[0]?.id, "btn");
});

// REGRESSION (corrective): normalizeKey must NOT strip a real accessible name that ends in
// brackets (badge counts "Inbox [5]", draft markers "Edit [Draft]") — only ARIA state tokens.
// A generic trailing-[...] strip truncates the real name, colliding distinct siblings in mergeAttrs
// (first-wins drops the second's attrs) and missing the stateMap lookup for bracketed-name nodes.
test("REGRESSION: normalizeKey preserves real bracketed names, strips only ARIA state tokens", () => {
  assert.equal(normalizeKey("link: Inbox [5]"), "link: Inbox [5]", "badge-count name preserved");
  assert.equal(normalizeKey("link: Edit [Draft]"), "link: Edit [Draft]", "draft-marker name preserved");
  assert.equal(normalizeKey("button: Submit [disabled]"), "button: Submit", "ARIA state still stripped");
  assert.equal(normalizeKey("textbox: Email [required] [disabled]"), "textbox: Email", "multiple state tokens stripped");
});

test("REGRESSION: mergeAttrs does NOT collide two siblings differing only in a real bracket suffix", () => {
  const nodes = ["link: Inbox [5]", "link: Inbox [3]"];
  const rawAttrs = [
    { key: "link: Inbox [5]", id: "inbox-unread" },
    { key: "link: Inbox [3]", id: "inbox-flagged" },
  ];
  const result = mergeAttrs(nodes, rawAttrs);
  assert.equal(result.length, 2, "both bracketed-name siblings kept (no first-wins collision)");
  assert.equal(result.find((a) => a.key === "link: Inbox [5]")?.id, "inbox-unread");
  assert.equal(result.find((a) => a.key === "link: Inbox [3]")?.id, "inbox-flagged");
});

// Task 4.8 RED: selector-check.ts parseLine state-strip
// parseLine is private in selector-check.ts — we test via selectorPresent (the public API)
// which calls parseLine internally. If parseLine strips the suffix, selectorPresent
// will correctly match "button: Submit" even when the line has "[disabled]" suffix.
test("4.8 [RED→GREEN] selectorPresent: correctly matches node line with state suffix", async () => {
  // If parseLine strips "[disabled]", role=button name=Submit matches "button: Submit [disabled]"
  const { selectorPresent: sp } = await import("@contexts/qa-run-orchestration/domain/helpers/selector-check.ts");
  const tree = ["button: Submit [disabled]"];
  const sel = { kind: "role" as const, role: "button", name: "Submit" };
  const result = sp(sel, tree);
  assert.equal(result.present, true, "selectorPresent must match even with state suffix on node line");
  assert.equal(result.verifiable, true);
});

// Task 4.9 UPDATE: existing state-stripping tests — add companion assertions on parseAriaSnapshotWithState
test("4.9 parseAriaSnapshotWithState companion: state IS captured in parallel map (not lost)", () => {
  // The existing tests assert state is NOT in nodes[] — we now also verify it IS in states map
  const yaml = `
- checkbox "Subscribe" [checked]
- checkbox "Newsletter" [disabled]
- option "Dog" [selected]
`.trim();
  const { nodes, states } = parseAriaSnapshotWithState(yaml);
  // nodes[] still bare (existing invariant)
  assert.ok(!nodes.some((l) => l.includes("[checked]")), "no state bracket in nodes[]");
  assert.ok(!nodes.some((l) => l.includes("[disabled]")), "no state bracket in nodes[]");
  assert.ok(!nodes.some((l) => l.includes("[selected]")), "no state bracket in nodes[]");
  // states map captures what was stripped
  assert.deepEqual(states.get("checkbox: Subscribe"), ["checked"], "checked captured");
  assert.deepEqual(states.get("checkbox: Newsletter"), ["disabled"], "disabled captured");
  assert.deepEqual(states.get("option: Dog"), ["selected"], "selected captured");
});

// Phase 5: Non-regression sweep tests (5.1, 5.2)
test("5.1 Slice 1 marker-absent-when-no-change: node with no state/inputType/nameFallback formats byte-identically", () => {
  // A node from the original keep-set with no new data must format identically
  const nodes = ["button: Submit", "link: Home", "table: (present)"];
  const snap1: RouteSnapshot[] = [{ route: "/form", nodes }];
  const snap2: RouteSnapshot[] = [{ route: "/form", nodes, states: new Map() }];
  const out1 = formatDomSnapshot(snap1);
  const out2 = formatDomSnapshot(snap2);
  assert.equal(out1, out2, "empty states map → byte-identical to no states at all");
  // No marker present when changed is undefined
  assert.ok(!out1.includes("[CHANGED:"), "no CHANGED marker when changed is not provided");
});

test("5.2 Byte-identical no-op: original-keep-set role with no new data formats identically before/after Slice 3", () => {
  // heading is in the original keep-set and gets no new fields
  const nodes = ["heading: Owners", "listitem: Item one"];
  const snap: RouteSnapshot[] = [{ route: "/", nodes }];
  const out = formatDomSnapshot(snap);
  // Lines should be indented with 2 spaces and no extra suffixes
  assert.ok(out.includes("  heading: Owners"), "heading formatted as-is");
  assert.ok(out.includes("  listitem: Item one"), "listitem formatted as-is");
  assert.ok(!out.includes("[disabled]"), "no stray state suffix");
  assert.ok(!out.includes("type="), "no stray inputType token");
});

// ── FIX B (TDD RED→GREEN): role-less hint-parity block in formatDomSnapshot ─────────────────────
// A <div data-cy=x> with no ARIA role is captured into RouteSnapshot.testIds but was INVISIBLE in
// the formatted prompt — the agent fabricated it. formatDomSnapshot must render a separate
// "test-ids on this route:" block so the agent can DISCOVER every value the gate will accept.

test("FIX-B-1: formatDomSnapshot appends 'test-ids on this route:' line when testIds is non-empty", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    testIds: new Map([["submit-btn", 1], ["header-logo", 1]]),
  }];
  const out = formatDomSnapshot(snap);
  assert.ok(out.includes("  test-ids on this route:"), "test-ids block present");
  assert.ok(out.includes("submit-btn"), "first test-id listed");
  assert.ok(out.includes("header-logo"), "second test-id listed");
});

test("FIX-B-2: formatDomSnapshot renders count>1 with ambiguity marker (×N)", () => {
  const snap: RouteSnapshot[] = [{
    route: "/form",
    nodes: ["button: Submit"],
    testIds: new Map([["submit-btn", 2], ["unique-id", 1]]),
  }];
  const out = formatDomSnapshot(snap);
  assert.ok(out.includes("submit-btn (×2)"), "duplicate test-id gets ambiguity marker");
  // count===1 renders bare (no marker)
  assert.ok(out.includes("unique-id") && !out.includes("unique-id (×"), "count=1 renders bare");
});

test("FIX-B-3 byte-identical guarantee: testIds absent/empty → output unchanged (existing no-op tests still pass)", () => {
  const nodes = ["button: Submit", "link: Home", "table: (present)"];
  const withAbsent = formatDomSnapshot([{ route: "/x", nodes }]);
  const withEmptyMap = formatDomSnapshot([{ route: "/x", nodes, testIds: new Map() }]);
  assert.equal(withAbsent, withEmptyMap, "empty testIds Map → byte-identical to testIds absent");
  // Confirm the test-ids block is NOT present
  assert.ok(!withAbsent.includes("test-ids on this route:"), "no test-ids block when testIds absent");
  assert.ok(!withEmptyMap.includes("test-ids on this route:"), "no test-ids block when testIds empty");
});

// ── FIX D (TDD): captureRouteTrees loud degraded warning integration ─────────────────────────────
// Pins that the degraded-route warning actually REACHES console.warn (today only the return value of
// degradedRouteWarning is tested, not the wiring into the real console).

test("FIX-D: captureRouteTrees calls console.warn when a render returns an errored route", async () => {
  const spec = `await page.goto("/owners");`;
  const deps: CaptureDomDeps = {
    render: async () => [{ route: "/owners", error: "Timeout 15000ms exceeded" }],
  };
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [spec] }, deps);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned.length > 0, "console.warn must be called when a route is degraded");
  const msg = warned.join(" ");
  assert.ok(msg.includes("/owners"), "warning names the degraded route");
  assert.ok(msg.includes("DEGRADED") || msg.includes("WARNING"), "warning is attributable as a degraded-capture event");
});

// ── Round 3 (re-judge): captureDomForRoutes is the FOURTH capture path; per-route degrade must be loud
// there too (a render that returns WITHOUT throwing but with errored routes was silently swallowed —
// formatDomSnapshot renders the error as text so text.trim() is truthy and no warning fired). ──────
test("captureDomForRoutes warns when a render returns an errored route (4th path, loud degrade)", async () => {
  const deps: CaptureDomDeps = {
    render: async () => [{ route: "/owners", error: "Timeout 15000ms exceeded" }],
  };
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    await captureDomForRoutes(["/owners"], { e2eDir: "/m", baseUrl: "http://dev" }, deps);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned.length > 0, "console.warn must fire on a degraded route in captureDomForRoutes");
  const msg = warned.join(" ");
  assert.ok(msg.includes("/owners"), "warning names the degraded route");
  assert.ok(msg.includes("DEGRADED") || msg.includes("WARNING"), "attributed as a degraded-capture event");
});

// ── Fix 1 (audit leak 4): authenticated DOM capture — DEV_ENV_* httpCredentials in the render child ──
// The render child spawns a separate Node process that does chromium.launch() + newContext(). A
// comment claimed scrubEnv(/^DEV_/) passes DEV_ENV_USER/PASS through to the child so gated routes
// render authenticated — but the child script never read those env vars into newContext(). Auth-gated
// routes therefore grounded on the login/401 page. Mirrors config/e2e/playwright.config.ts's
// httpCredentials idiom, scoped to baseUrl's origin so creds never leak to a different-origin auth
// provider (e.g. Keycloak).

test("buildCaptureScript wires DEV_ENV_USER/DEV_ENV_PASS into httpCredentials on newContext()", () => {
  const script = buildCaptureScript();
  assert.match(script, /process\.env\.DEV_ENV_USER/, "must read DEV_ENV_USER from the child's env");
  assert.match(script, /process\.env\.DEV_ENV_PASS/, "must read DEV_ENV_PASS from the child's env");
  assert.match(script, /httpCredentials/, "must wire httpCredentials into newContext()");
  assert.match(script, /newContext\(/, "newContext() call must still be present");
});

test("buildCaptureScript scopes httpCredentials to baseUrl's origin (creds must not leak cross-origin)", () => {
  const script = buildCaptureScript();
  assert.match(script, /origin:\s*new URL\(baseUrl\)\.origin/, "httpCredentials must be scoped via origin: new URL(baseUrl).origin");
});

test("buildCaptureScript sets httpCredentials when DEV_ENV_USER alone is present (username-only parity with playwright.config.ts)", () => {
  const script = buildCaptureScript();
  // Matches config/e2e/playwright.config.ts's gate: `DEV_ENV_USER ? { username, password: DEV_ENV_PASS ?? "", origin } : undefined`.
  // Gating on `user && pass` silently drops credentials whenever only DEV_ENV_USER is set — a real
  // deployment gap this test pins closed. The gate is `user` alone; password defaults to "".
  assert.match(script, /\buser\s*\?/, "must gate httpCredentials on user alone, not user && pass");
  assert.doesNotMatch(script, /user\s*&&\s*pass/, "must NOT require both user and pass to be truthy");
  assert.match(script, /pass\s*\?\?\s*["']["']/, "password must default to \"\" when DEV_ENV_PASS is unset");
});

// ── Fix 2 (audit leak 5): capture pageerror/console + degrade empty or redirected routes ──

test("buildCaptureScript registers pageerror and console error collectors before navigation", () => {
  const script = buildCaptureScript();
  assert.match(script, /page\.on\(\s*["']pageerror["']/, "must register a pageerror listener");
  assert.match(script, /page\.on\(\s*["']console["']/, "must register a console listener");
  // Registration must happen BEFORE the goto() call so errors during navigation/settle are caught.
  const pageErrorIdx = script.indexOf('page.on("pageerror"');
  const gotoIdx = script.indexOf("page.goto(");
  assert.ok(pageErrorIdx !== -1 && gotoIdx !== -1 && pageErrorIdx < gotoIdx,
    "pageerror listener must be registered before goto()");
});

test("buildCaptureScript accumulates runtimeErrors per-route (reset each iteration) and records finalUrl", () => {
  const script = buildCaptureScript();
  assert.match(script, /runtimeErrors/, "must include runtimeErrors in the per-route output");
  assert.match(script, /finalUrl/, "must include finalUrl in the per-route output");
  assert.match(script, /page\.url\(\)/, "finalUrl must be captured via page.url()");
});

test("RouteSnapshot accepts runtimeErrors and finalUrl fields", () => {
  const snap: RouteSnapshot = {
    route: "/login",
    nodes: [],
    runtimeErrors: [{ type: "pageerror", text: "Uncaught TypeError: x is not a function" }],
    finalUrl: "http://dev/login",
  };
  assert.equal(snap.runtimeErrors?.length, 1);
  assert.equal(snap.finalUrl, "http://dev/login");
  // Absent is still valid — byte-identical to today's shape when unset.
  const withoutFields: RouteSnapshot = { route: "/home", nodes: [] };
  assert.equal(withoutFields.runtimeErrors, undefined);
  assert.equal(withoutFields.finalUrl, undefined);
});


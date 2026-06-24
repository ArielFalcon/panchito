import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTargetRoutes, formatDomSnapshot, parseAriaSnapshot, captureDom, captureDomByRoute, captureRouteTrees, normalizeRoutes, capDomLines, isPriorityNode, mergeAttrs, type CaptureDomDeps, type NodeAttr, type RouteSnapshot } from "./dom-snapshot";

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
  assert.deepEqual(await captureRouteTrees({ e2eDir: "/m", baseUrl: "http://dev", specContents: [`page.goto("/a"); page.goto("/b")`] }, errored), [], "errored + empty-nodes excluded");
});

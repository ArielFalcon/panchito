import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTargetRoutes, formatDomSnapshot, parseAriaSnapshot, captureDom, capDomLines, isPriorityNode, type CaptureDomDeps } from "./dom-snapshot";

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

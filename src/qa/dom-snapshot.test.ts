import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTargetRoutes, parseAriaSnapshot, normalizeRoutes } from "./dom-snapshot";

// ── extractTargetRoutes ──────────────────────────────────────────────────────

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
// the "role: name" output lines the DOM-grounding callers expect.

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

// ── normalizeRoutes ───────────────────────────────────────────────────────────

test("normalizeRoutes trims, drops absolute/interpolated URLs, and dedupes", () => {
  assert.deepEqual(
    normalizeRoutes([" /a ", "/a", "https://x.com/y", "/p/${id}", "/b"]),
    ["/a", "/b"],
  );
});

// Task 4.2 RED: bare nodes[] invariant — parseAriaSnapshot must NOT include state suffix.
// The invariant already holds today, but we write an EXPLICIT assertion to lock it.
test("4.2 [RED→GREEN] parseAriaSnapshot: state suffix [disabled] NEVER appears in nodes[] output", () => {
  const result = parseAriaSnapshot('- button "Submit" [disabled]');
  assert.deepEqual(result, ["button: Submit"], `nodes[] must be bare; got ${JSON.stringify(result)}`);
  assert.ok(!result.some((l) => l.includes("[disabled]")), "no state suffix in nodes[]");
  assert.ok(!result.some((l) => l.includes("[checked]")), "no [checked] in nodes[]");
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

// Task 4.8 RED: selector-check.ts parseLine state-strip. This test is independent of the functions
// this file exports (it dynamically imports the qa-engine port of selector-check.ts and hardcodes
// its input tree) — kept here because it is a cross-file drift guard between the two files'
// "role: name [state]" grammar. src/qa/selector-check.ts was deleted (migration-wiring-phase-2,
// Slice 8b-4); parseLine is private in the qa-engine port too — we test via selectorPresent (the
// public API) which calls parseLine internally. If parseLine strips the suffix, selectorPresent
// will correctly match "button: Submit" even when the line has "[disabled]" suffix.
test("4.8 [RED→GREEN] selectorPresent: correctly matches node line with state suffix", async () => {
  // If parseLine strips "[disabled]", role=button name=Submit matches "button: Submit [disabled]"
  const { selectorPresent: sp } = await import("@contexts/qa-run-orchestration/domain/helpers/selector-check");
  const tree = ["button: Submit [disabled]"];
  const sel = { kind: "role" as const, role: "button", name: "Submit" };
  const result = sp(sel, tree);
  assert.equal(result.present, true, "selectorPresent must match even with state suffix on node line");
  assert.equal(result.verifiable, true);
});

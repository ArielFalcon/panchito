import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the re-ported checkSpecSelectors (Task D.4's Lever-2 dependency, sub-decision 2) must
// match src/qa/selector-check.ts's CURRENT checkSpecSelectors exactly. Re-ported here (not reused
// from test-execution/domain/selector-check.service.ts) because that sibling copy has DRIFTED
// (missing the string-aware comment-strip + catalog-gate additions from recent Pillar-2 work) — this
// task re-ports from the TRUE current legacy source directly, scoped to ONLY checkSpecSelectors and
// its direct dependencies (the catalog-gate extractors are addendum G2's separate, out-of-scope
// concern). This file imports src/qa/selector-check.ts, so it is added to the qa-engine typecheck
// "exclude" list (same parity-import pattern as derive-cycle-backstop-parity.test.ts).
import {
  checkSpecSelectors,
  unscopedMultipleContradictions,
  extractCatalogSelectors,
  confidentWindowEnd,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
  type ProposedSelector,
} from "@contexts/qa-run-orchestration/domain/helpers/selector-check.ts";
import {
  checkSpecSelectors as legacy,
  unscopedMultipleContradictions as legacyUnscopedMultipleContradictions,
  extractCatalogSelectors as legacyExtractCatalogSelectors,
  confidentWindowEnd as legacyConfidentWindowEnd,
  extractTestIdSelectorsWithIndex as legacyExtractTestIdSelectorsWithIndex,
  firstGotoRoute as legacyFirstGotoRoute,
} from "../../../../../../src/qa/selector-check.ts";

test("PARITY: checkSpecSelectors matches legacy — present + unique selector", () => {
  const specs = [`await page.getByRole("button", { name: "Add Owner" }).click();`];
  const trees = [["button: Add Owner", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — verifiable-absent selector", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — MULTIPLE-node strict-mode ambiguity", () => {
  const specs = [`await page.getByRole("textbox", { name: "Owner name" }).fill("x");`];
  const trees = [["textbox: Owner name", "textbox: Owner name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — unverifiable (role never seen with a real name)", () => {
  const specs = [`await page.getByRole("button", { name: "Ghost" }).click();`];
  const trees = [["textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — non-extractable locator flags anyNonExtractable", () => {
  const specs = [`await page.getByTestId("submit-btn").click();`];
  const trees = [["button: Submit"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — per-tree (never fused): present on tree A, absent on tree B is NOT absent", () => {
  const specs = [`await page.getByRole("button", { name: "Checkout" }).click();`];
  const trees = [["button: Checkout"], ["textbox: Search"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — a commented-out selector is not extracted (W5)", () => {
  const specs = [
    `// await page.getByRole("button", { name: "Ghost" }).click();\nawait page.getByRole("button", { name: "Real" }).click();`,
  ];
  const trees = [["button: Real"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — a URL inside a string is not mistaken for a comment (string-aware strip)", () => {
  const specs = [`await page.goto("https://example.com/checkout"); // comment\nawait page.getByRole("button", { name: "Pay" }).click();`];
  const trees = [["button: Pay"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — empty trees yields empty findings (safe no-op)", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees: string[][] = [];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — custom treeLabel threads into the absent message", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel"]];
  assert.deepEqual(checkSpecSelectors(specs, trees, "pre-write"), legacy(specs, trees, "pre-write"));
});

test("PARITY: checkSpecSelectors matches legacy — (present) structural marker never name-matches (W2)", () => {
  const specs = [`await page.getByRole("row", { name: "Present" }).click();`];
  const trees = [["row: (present)"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — getByText and getByLabel kinds", () => {
  const specs = [
    `await page.getByText("Welcome back").click(); await page.getByLabel("Email").fill("x@example.com");`,
  ];
  const trees = [["text: Welcome back", "textbox: Email"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — multiple spec sources aggregate findings", () => {
  const specs = [
    `await page.getByRole("button", { name: "Save" }).click();`,
    `await page.getByRole("button", { name: "Delete" }).click();`,
  ];
  const trees = [["button: Save"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: ProposedSelector shape round-trips through both copies identically (structural sanity)", () => {
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit", exact: true };
  assert.deepEqual(sel, { kind: "role", role: "button", name: "Submit", exact: true });
});

// ── B5.1 (Plan 7-R): catalog-gate extractors ported into the canonical module ──────────────────
// B0's header explicitly deferred these as "addendum G2's SEPARATE, out-of-scope concern" — B5
// closes that gap: pre-exec-grounding.service.ts (B5.2) needs extractCatalogSelectors/
// confidentWindowEnd/extractTestIdSelectorsWithIndex/firstGotoRoute + unscopedMultipleContradictions
// living in the SAME canonical module as checkSpecSelectors (composing route-catalog/catalog-gate
// would otherwise force a second, parallel port of these four functions).

test("PARITY: extractCatalogSelectors matches legacy — testIds/placeholders/altTexts/titles/idsNames", () => {
  const src = `await page.getByTestId("save-btn").click(); await page.getByPlaceholder("Search").fill("x"); await page.getByAltText("Logo").click(); await page.getByTitle("Close").click(); await page.locator("#main-nav").click(); await page.locator('[name="email"]').fill("x");`;
  assert.deepEqual(extractCatalogSelectors(src), legacyExtractCatalogSelectors(src));
});

test("PARITY: extractCatalogSelectors matches legacy — interpolated values are dropped (un-groundable)", () => {
  const src = "await page.getByTestId(`row-${id}`).click();";
  assert.deepEqual(extractCatalogSelectors(src), legacyExtractCatalogSelectors(src));
});

test("PARITY: confidentWindowEnd matches legacy — closes at the first click", () => {
  const src = `await page.goto("/owners"); await page.getByRole("button", { name: "Add" }).click(); await page.getByTestId("late-id").click();`;
  assert.equal(confidentWindowEnd(src), legacyConfidentWindowEnd(src));
});

test("PARITY: confidentWindowEnd matches legacy — closes at the second goto", () => {
  const src = `await page.goto("/owners"); await page.goto("/owners/new"); await page.getByTestId("late-id").click();`;
  assert.equal(confidentWindowEnd(src), legacyConfidentWindowEnd(src));
});

test("PARITY: confidentWindowEnd matches legacy — Infinity when nothing closes the window", () => {
  const src = `await page.goto("/owners"); await page.fill("#x", "y");`;
  assert.equal(confidentWindowEnd(src), legacyConfidentWindowEnd(src));
  assert.equal(confidentWindowEnd(src), Infinity);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — value + index pairs, interpolated dropped", () => {
  const src = `await page.getByTestId("save-btn").click(); await page.getByTestId(\`row-\${id}\`).click();`;
  assert.deepEqual(extractTestIdSelectorsWithIndex(src), legacyExtractTestIdSelectorsWithIndex(src));
});

test("PARITY: firstGotoRoute matches legacy — literal route, leading slash normalized", () => {
  const src = `await page.goto("owners");`;
  assert.equal(firstGotoRoute(src), legacyFirstGotoRoute(src));
  assert.equal(firstGotoRoute(src), "/owners");
});

test("PARITY: firstGotoRoute matches legacy — un-navigable (interpolated / absolute URL) yields undefined", () => {
  const interpolated = "await page.goto(`/owners/${id}`);";
  const absolute = `await page.goto("https://example.com/owners");`;
  assert.equal(firstGotoRoute(interpolated), legacyFirstGotoRoute(interpolated));
  assert.equal(firstGotoRoute(absolute), legacyFirstGotoRoute(absolute));
  assert.equal(firstGotoRoute(interpolated), undefined);
  assert.equal(firstGotoRoute(absolute), undefined);
});

// ── B5.1: unscopedMultipleContradictions — base behavior parity (matches legacy's CURRENT,
// pre-idiom-aware-fix semantics) ─────────────────────────────────────────────────────────────
test("PARITY: unscopedMultipleContradictions matches legacy — page-rooted MULTIPLE survives suppression", () => {
  const specs = [`page.getByRole("button").click(); page.getByTestId("x").click();`];
  const trees = [["button: A", "button: B"]];
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), legacyUnscopedMultipleContradictions(specs, trees));
});

test("PARITY: unscopedMultipleContradictions matches legacy — no non-extractable locator, fast path returns MULTIPLE as-is", () => {
  const specs = [`page.getByRole("button", { name: "Owner name" }).fill("x");`];
  const trees = [["textbox: Owner name", "textbox: Owner name"]];
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), legacyUnscopedMultipleContradictions(specs, trees));
});

// ── B5.1: idiom-aware MULTIPLE suppression (declared divergence — the canonical module now
// SUPPRESSES two false-block idioms legacy's unscopedMultipleContradictions does NOT: a selector
// followed by .first(/.nth(/.filter( (the AUTHOR already disambiguated it), and a selector preceded
// by an extractable scope chain (e.g. .getByRole("table").getByRole("row", {...}) — already scoped
// to a unique parent even though BOTH ends are extractable, a case the legacy page-rooted check
// alone cannot see because isPageRootedAt only inspects the IMMEDIATE prefix token). Per B5's own
// safe-direction invariant, this only NARROWS blocking — it can never fabricate a new contradiction.

test("DECLARED divergence (Plan 7-R B5.1): .first() suppresses a MULTIPLE the legacy still surfaces", () => {
  const specs = [`await page.getByRole("row").first().click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const legacyResult = legacyUnscopedMultipleContradictions(specs, trees);
  assert.ok(legacyResult.length > 0, "sanity: legacy still surfaces the MULTIPLE for a page-rooted role-only selector");
  const rewritten = unscopedMultipleContradictions(specs, trees);
  assert.deepEqual(rewritten, [], ".first() disambiguates — no contradiction should surface");
});

test("DECLARED divergence (Plan 7-R B5.1): .nth() suppresses a MULTIPLE the legacy still surfaces", () => {
  const specs = [`await page.getByRole("row").nth(1).click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const legacyResult = legacyUnscopedMultipleContradictions(specs, trees);
  assert.ok(legacyResult.length > 0, "sanity: legacy still surfaces the MULTIPLE for a page-rooted role-only selector");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("DECLARED divergence (Plan 7-R B5.1): .filter() suppresses a MULTIPLE the legacy still surfaces", () => {
  const specs = [`await page.getByRole("row").filter({ hasText: "Edit" }).click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const legacyResult = legacyUnscopedMultipleContradictions(specs, trees);
  assert.ok(legacyResult.length > 0, "sanity: legacy still surfaces the MULTIPLE for a page-rooted role-only selector");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("DECLARED divergence (Plan 7-R B5.1): role-chained scoping (table.getByRole(...)) suppresses a MULTIPLE", () => {
  const specs = [`await page.getByRole("table").getByRole("row", { name: "x" }).click();`];
  const trees = [["table: (present)", "row: x", "row: x"]];
  const legacyResult = legacyUnscopedMultipleContradictions(specs, trees);
  assert.ok(legacyResult.length > 0, "sanity: legacy's page-rooted check still surfaces this MULTIPLE (it only inspects the immediate prefix token, missing the .getByRole('table') scope chain)");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("B5.1: page-rooted suppression applies UNCONDITIONALLY (no anyNonExtractable gate) — a real ambiguity with NO non-extractable locator anywhere still surfaces", () => {
  // Regression guard for the OTHER B5.1 fix ("page-rooted suppression applies unconditionally, not
  // gated on anyNonExtractable"): a spec with ZERO non-extractable locators must still surface a
  // genuine page-rooted MULTIPLE (this must NOT start returning [] just because the idiom-aware
  // suppression logic now always runs the per-selector path instead of the anyNonExtractable fast path).
  const specs = [`await page.getByRole("button", { name: "Save" }).click();`];
  const trees = [["button: Save", "button: Save"]];
  const result = unscopedMultipleContradictions(specs, trees);
  assert.equal(result.length, 1);
  assert.match(result[0]!, /MULTIPLE/);
});

// Unit tests for src/qa/selector-check.ts — Lever 2 pure selector verification.
// All spec #560 Unit 2 selector-check scenarios are covered here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  selectorPresent,
  selectorUnique,
  extractProposedSelectors,
  hasNonExtractableLocator,
  checkSpecSelectors,
  selectorKey,
  type ProposedSelector,
} from "./selector-check";

// ── normalizeName ─────────────────────────────────────────────────────────────

test("normalizeName: collapses whitespace runs to a single space and trims", () => {
  assert.equal(normalizeName("  Owner  name  "), "Owner name");
  assert.equal(normalizeName("Owner\t\tname"), "Owner name");
  assert.equal(normalizeName("line1\nline2"), "line1 line2");
  assert.equal(normalizeName("  \t trim \n "), "trim");
  assert.equal(normalizeName("no change"), "no change");
});

// ── selectorPresent — basic cases ─────────────────────────────────────────────

test("selectorPresent: default (ci substring) matches a node whose name contains the expected string", () => {
  // Spec #560 scenario: tree has "button: Cancel order", selector name is "Cancel"
  const tree = ["button: Cancel order", "link: Home"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Cancel" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, true);
  assert.equal(result.verifiable, true);
});

test("selectorPresent: exact:true rejects a substring match", () => {
  // Spec #560 scenario: "Cancel order" ≠ "Cancel" with exact:true
  const tree = ["button: Cancel order"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Cancel", exact: true };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, true); // role IS in the tree
});

test("selectorPresent: exact:true matches when names are exactly equal (after normalization)", () => {
  const tree = ["button: Cancel order"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Cancel order", exact: true };
  assert.equal(selectorPresent(sel, tree).present, true);
});

test("selectorPresent: role-only (no name) matches any node of that role", () => {
  // Spec #560 scenario: selector {role: "button"} matches any button
  const tree = ["button: Submit", "link: Home"];
  const sel: ProposedSelector = { kind: "role", role: "button" };
  assert.equal(selectorPresent(sel, tree).present, true);
});

test("selectorPresent: absent selector is UNVERIFIABLE when role is not in the snapshot", () => {
  // Spec #560 scenario: no columnheader in the tree → {present: false, verifiable: false}
  const tree = ["button: Submit", "link: Home"];
  const sel: ProposedSelector = { kind: "role", role: "columnheader", name: "Name" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, false); // role absent from snapshot → may be pruned
});

test("selectorPresent: role present but name absent → present:false, verifiable:true (definitive absence)", () => {
  // Role IS in the tree, so its absence is conclusive (not just pruning).
  const tree = ["button: OK", "button: Cancel"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, true);
});

// W4: a name-bearing selector whose role appears ONLY as a `(present)` structural marker (the
// composed name was dropped by parseAriaSnapshot) must be UNVERIFIABLE, not a false ABSENT — a
// false contradiction would steer the agent away from a correct selector.
test("selectorPresent: name-bearing selector vs a role seen ONLY as '(present)' is UNVERIFIABLE, not absent", () => {
  const tree = ["table: (present)", "row: (present)", "link: Home"]; // row's name dropped
  const sel: ProposedSelector = { kind: "role", role: "row", name: "Bob Smith" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, false, "a (present)-only role must NOT yield a verifiable contradiction");
});

test("selectorPresent: role-only selector DOES match a '(present)' structural marker", () => {
  // No name → the role's mere presence satisfies it (this is the intended use of the marker).
  const tree = ["row: (present)"];
  const sel: ProposedSelector = { kind: "role", role: "row" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, true);
  assert.equal(result.verifiable, true);
});

// W2: the `(present)` literal must NOT be substring-matchable by a selector NAME. A default
// ci-substring selector name:"Present" (or "res"/"sent"/"ent") would substring-match the literal
// "(present)" → a spurious present:true that suppresses a real absent-contradiction and can fake
// uniqueness. nameMatches short-circuits a name-bearing selector to NO MATCH against the marker.
test("selectorPresent: name 'Present' does NOT substring-match a '(present)' structural marker (W2)", () => {
  const tree = ["row: (present)"]; // row's real name was dropped → only the structural marker
  // "Present" substrings "(present)" under ci-substring — must NOT count as present.
  const sel: ProposedSelector = { kind: "role", role: "row", name: "Present" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false, "a name-bearing selector must not match the (present) marker via substring");
  assert.equal(result.verifiable, false, "the role appeared only as (present) → unverifiable, not a false contradiction");
  // The fragment "ent" also substrings "(present)" — still no match.
  assert.equal(selectorPresent({ kind: "role", role: "row", name: "ent" }, tree).present, false);
});

// W2 (uniqueness): the marker must not satisfy uniqueness either — a name:"Present" against a single
// `row: (present)` line must count ZERO matches, so it can never fake an `allUnique` real-bug verdict.
test("selectorUnique: name 'Present' counts ZERO against a '(present)' marker (W2)", () => {
  const tree = ["row: (present)"];
  const sel: ProposedSelector = { kind: "role", role: "row", name: "Present" };
  assert.equal(selectorUnique(sel, tree), false, "the (present) marker must not be a unique name match");
});

test("selectorPresent: a real-named node of the same role still makes a name-mismatch conclusive", () => {
  // The tree has BOTH a (present) row AND a named row → the named row makes Bob Smith's absence
  // conclusive (verifiable:true), because the role WAS observed carrying a real name.
  const tree = ["row: (present)", "row: Alice Jones"];
  const sel: ProposedSelector = { kind: "role", role: "row", name: "Bob Smith" };
  const result = selectorPresent(sel, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, true);
});

test("selectorPresent: default match is case-insensitive", () => {
  const tree = ["button: CANCEL ORDER"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "cancel" };
  assert.equal(selectorPresent(sel, tree).present, true);
});

test("selectorPresent: exact match is case-sensitive", () => {
  const tree = ["button: Cancel Order"];
  // Exact match with different case → no match.
  const selLower: ProposedSelector = { kind: "role", role: "button", name: "cancel order", exact: true };
  assert.equal(selectorPresent(selLower, tree).present, false);
  // Exact match with correct case → match.
  const selCorrect: ProposedSelector = { kind: "role", role: "button", name: "Cancel Order", exact: true };
  assert.equal(selectorPresent(selCorrect, tree).present, true);
});

test("selectorPresent: regex name matches against normalized actual name", () => {
  const tree = ["button: Submit form"];
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit", isRegex: true };
  assert.equal(selectorPresent(sel, tree).present, true);
});

test("selectorPresent: regex name does NOT lowercase — regex is tested directly", () => {
  const tree = ["button: Submit"];
  // This regex requires uppercase S — matches because 'Submit' starts with uppercase.
  const selUpper: ProposedSelector = { kind: "role", role: "button", name: "^Submit$", isRegex: true };
  assert.equal(selectorPresent(selUpper, tree).present, true);
  // This regex requires lowercase s — should NOT match "Submit".
  const selLower: ProposedSelector = { kind: "role", role: "button", name: "^submit$", isRegex: true };
  assert.equal(selectorPresent(selLower, tree).present, false);
});

test("selectorPresent: whitespace normalization applied to both sides for exact match", () => {
  // Spec #560 scenario: selector name "  Owner  name  " normalizes to "Owner name"
  // tree node name "Owner name" also normalizes to "Owner name" → exact match succeeds
  const tree = ["textbox: Owner name"];
  const sel: ProposedSelector = { kind: "role", role: "textbox", name: "  Owner  name  ", exact: true };
  assert.equal(selectorPresent(sel, tree).present, true);
});

test("selectorPresent: never throws on malformed input", () => {
  assert.doesNotThrow(() => selectorPresent({ kind: "role" }, []));
  assert.doesNotThrow(() => selectorPresent({ kind: "role", role: "button", name: "" }, ["button: Submit"]));
  assert.doesNotThrow(() => selectorPresent({ kind: "role", role: "button", isRegex: true, name: "[invalid" }, ["button: Submit"]));
});

// ── selectorPresent — getByText and getByLabel kind mapping ────────────────────

test("selectorPresent: getByText kind matches text and textual-content roles", () => {
  const tree = ["text: some label text", "heading: Page Title", "button: Submit"];
  const selText: ProposedSelector = { kind: "text", name: "some label" };
  assert.equal(selectorPresent(selText, tree).present, true);
  const selHeading: ProposedSelector = { kind: "text", name: "Page Title" };
  assert.equal(selectorPresent(selHeading, tree).present, true);
  // Buttons also match getByText (common usage).
  const selButton: ProposedSelector = { kind: "text", name: "Submit" };
  assert.equal(selectorPresent(selButton, tree).present, true);
});

test("selectorPresent: getByLabel kind matches labelled input roles (textbox, combobox, checkbox)", () => {
  const tree = ["textbox: Owner name", "combobox: Species", "checkbox: Agree"];
  const selTextbox: ProposedSelector = { kind: "label", name: "Owner name" };
  assert.equal(selectorPresent(selTextbox, tree).present, true);
  const selCombobox: ProposedSelector = { kind: "label", name: "Species" };
  assert.equal(selectorPresent(selCombobox, tree).present, true);
  const selCheckbox: ProposedSelector = { kind: "label", name: "Agree" };
  assert.equal(selectorPresent(selCheckbox, tree).present, true);
});

// ── selectorUnique ────────────────────────────────────────────────────────────

test("selectorUnique: returns true when exactly one node matches", () => {
  const tree = ["textbox: Owner name", "textbox: Pet name"];
  const sel: ProposedSelector = { kind: "role", role: "textbox", name: "Owner name" };
  assert.equal(selectorUnique(sel, tree), true);
});

test("selectorUnique: returns false when more than one node matches (strict-mode ambiguity)", () => {
  // Spec #560 scenario: two nodes "textbox: Owner name" → non-unique
  const tree = ["textbox: Owner name", "textbox: Owner name"];
  const sel: ProposedSelector = { kind: "role", role: "textbox", name: "Owner name" };
  assert.equal(selectorUnique(sel, tree), false);
});

test("selectorUnique: returns false when no node matches (absent → not unique)", () => {
  const tree = ["button: Submit"];
  const sel: ProposedSelector = { kind: "role", role: "textbox", name: "Owner name" };
  assert.equal(selectorUnique(sel, tree), false);
});

test("selectorUnique: role-only selector catches multiple nodes of same role", () => {
  const tree = ["button: Submit", "button: Cancel"];
  const sel: ProposedSelector = { kind: "role", role: "button" }; // matches all buttons
  assert.equal(selectorUnique(sel, tree), false);
});

// ── extractProposedSelectors ───────────────────────────────────────────────────

test("extractProposedSelectors: extracts getByRole with name", () => {
  const src = `await page.getByRole("button", { name: "Submit" }).click();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "role", role: "button", name: "Submit" });
});

test("extractProposedSelectors: extracts getByRole with exact:true", () => {
  const src = `await page.getByRole("button", { name: "Cancel order", exact: true }).click();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "role", role: "button", name: "Cancel order", exact: true });
});

test("extractProposedSelectors: extracts getByRole without options (role-only)", () => {
  const src = `await page.getByRole("link").click();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "role", role: "link" });
});

test("extractProposedSelectors: extracts getByRole with regex name", () => {
  const src = `await page.getByRole("button", { name: /Submit/i }).click();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.kind, "role");
  assert.equal(sels[0]!.role, "button");
  assert.equal(sels[0]!.name, "Submit");
  assert.equal(sels[0]!.isRegex, true);
});

test("extractProposedSelectors: extracts getByText", () => {
  const src = `await page.getByText("Owner registered").isVisible();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "text", name: "Owner registered" });
});

test("extractProposedSelectors: extracts getByLabel", () => {
  const src = `await page.getByLabel("Owner name").fill("John");`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "label", name: "Owner name" });
});

test("extractProposedSelectors: extracts multiple selectors from a multi-line spec", () => {
  const src = [
    `await page.getByRole("button", { name: "Submit" }).click();`,
    `await page.getByLabel("First name").fill("John");`,
    `await page.getByText("Success").isVisible();`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 3);
  assert.equal(sels[0]!.kind, "role");
  assert.equal(sels[1]!.kind, "label");
  assert.equal(sels[2]!.kind, "text");
});

test("extractProposedSelectors: skips commented-out lines", () => {
  const src = [
    `// await page.getByRole("button", { name: "Hidden" }).click();`,
    `await page.getByRole("button", { name: "Visible" }).click();`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.name, "Visible");
});

test("extractProposedSelectors: returns empty array for spec with no recognized locator calls", () => {
  const src = `test("empty", async () => { await page.goto("/"); });`;
  assert.deepEqual(extractProposedSelectors(src), []);
});

// W2: a Prettier-wrapped getByRole (option object across multiple lines) must be captured — the
// old per-line scan silently skipped it, so Lever-2 missed real selectors and could misfire.
test("extractProposedSelectors: captures a Prettier-WRAPPED getByRole call (multi-line)", () => {
  const src = [
    `await page`,
    `  .getByRole("button", {`,
    `    name: "Add Owner",`,
    `    exact: true,`,
    `  })`,
    `  .click();`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.deepEqual(sels[0], { kind: "role", role: "button", name: "Add Owner", exact: true });
});

test("extractProposedSelectors: captures a wrapped getByRole with a regex name across lines", () => {
  const src = [
    `const btn = page.getByRole("link", {`,
    `  name: /sign ?in/i,`,
    `});`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.role, "link");
  assert.equal(sels[0]!.name, "sign ?in");
  assert.equal(sels[0]!.isRegex, true);
});

// W5: an INLINE `/* … */`-wrapped call on an otherwise-live line must NOT leak its selector. The old
// stripper only dropped lines STARTING with `//`/`*`, so an inline block comment survived and
// `getByRole("button",{name:"Ghost"})` leaked "Ghost" as a live selector.
test("extractProposedSelectors: does NOT capture an inline /* … */-wrapped call (W5)", () => {
  const src = `await page.getByRole("button", { name: "Real" }).click(); /* old: page.getByRole("button",{name:"Ghost"}) */`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1, "only the live selector survives; the block-commented one is stripped");
  assert.equal(sels[0]!.name, "Real");
  assert.ok(!sels.some((s) => s.name === "Ghost"), "the /* … */-wrapped Ghost selector must not leak");
});

// W5: a TRAILING `// …` line comment AFTER a live call must not leak its selector either.
test("extractProposedSelectors: does NOT capture a trailing // … commented call (W5)", () => {
  const src = `await page.getByRole("button", { name: "Real" }).click(); // page.getByRole("button",{name:"Ghost"})`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.name, "Real");
  assert.ok(!sels.some((s) => s.name === "Ghost"), "the trailing-// Ghost selector must not leak");
});

// W5: a `//` INSIDE a /* … */ block (e.g. a URL) must not cause mis-stripping that drops a later live
// call. Block comments are removed BEFORE the trailing-// strip, so the live selector after the block survives.
test("extractProposedSelectors: a // inside a /* … */ block does not break a later live call (W5)", () => {
  const src = `/* see http://example.com */ await page.getByRole("link", { name: "Docs" }).click();`;
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.name, "Docs");
});

test("extractProposedSelectors: does NOT capture a wrapped call whose opening line is commented out", () => {
  // A commented-out wrapped call: the `// .getByRole(...` line is dropped, so the orphan body
  // (`name: ...`, `})`) cannot form a match.
  const src = [
    `// await page.getByRole("button", {`,
    `//   name: "Hidden",`,
    `// }).click();`,
    `await page.getByRole("button", { name: "Visible" }).click();`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 1);
  assert.equal(sels[0]!.name, "Visible");
});

test("extractProposedSelectors: two adjacent wrapped calls are captured independently", () => {
  const src = [
    `page.getByRole("textbox", {`,
    `  name: "First",`,
    `}).fill("a");`,
    `page.getByRole("textbox", {`,
    `  name: "Last",`,
    `}).fill("b");`,
  ].join("\n");
  const sels = extractProposedSelectors(src);
  assert.equal(sels.length, 2);
  assert.deepEqual(sels.map((s) => s.name), ["First", "Last"]);
});

// ── hasNonExtractableLocator (W5) ─────────────────────────────────────────────

test("hasNonExtractableLocator: detects getByTestId / .locator() / getByPlaceholder / getByAltText / getByTitle", () => {
  assert.equal(hasNonExtractableLocator(`page.getByTestId("submit").click();`), true);
  assert.equal(hasNonExtractableLocator(`page.locator(".btn-primary").click();`), true);
  assert.equal(hasNonExtractableLocator(`page.getByPlaceholder("Email").fill("a");`), true);
  assert.equal(hasNonExtractableLocator(`page.getByAltText("logo").isVisible();`), true);
  assert.equal(hasNonExtractableLocator(`page.getByTitle("close").click();`), true);
});

test("hasNonExtractableLocator: false when the spec uses only extractable families", () => {
  const src = [
    `await page.getByRole("button", { name: "Add" }).click();`,
    `await page.getByText("Saved").isVisible();`,
    `await page.getByLabel("Name").fill("x");`,
  ].join("\n");
  assert.equal(hasNonExtractableLocator(src), false);
});

test("hasNonExtractableLocator: ignores a commented-out non-extractable call", () => {
  const src = [
    `// page.getByTestId("hidden").click();`,
    `await page.getByRole("button", { name: "Visible" }).click();`,
  ].join("\n");
  assert.equal(hasNonExtractableLocator(src), false);
});

// W4: a REGEX-first-arg getByText(/…/) / getByLabel(/…/) is NOT captured by extractProposedSelectors
// (string-literal only), so it must register as NON-extractable — otherwise a decorative present-unique
// getByRole makes allUnique true and the real-bug branch files a false "app defect" Issue for a
// regex-text/label value failure. (A STRING-literal getByText("…") stays extractable, NOT caught here.)
test("hasNonExtractableLocator: detects regex-first-arg getByText(/…/) and getByLabel(/…/) (W4)", () => {
  assert.equal(hasNonExtractableLocator(`page.getByText(/Owner registered/).isVisible();`), true);
  assert.equal(hasNonExtractableLocator(`page.getByText(/total: \\$\\d+/i).isVisible();`), true);
  assert.equal(hasNonExtractableLocator(`page.getByLabel(/Owner name/).fill("x");`), true);
  // A STRING-literal getByText/getByLabel is extractable → must NOT be flagged non-extractable.
  assert.equal(hasNonExtractableLocator(`page.getByText("Owner registered").isVisible();`), false);
  assert.equal(hasNonExtractableLocator(`page.getByLabel("Owner name").fill("x");`), false);
});

// W4: confirm the regex-first-arg forms are ALSO invisible to extraction (the other half of the gap) —
// extractProposedSelectors sees a string-literal getByText but NOT a regex one, so the guard above is
// the only thing that keeps uniqueness indeterminate for them.
test("extractProposedSelectors: a regex-first-arg getByText(/…/) is NOT extracted (W4)", () => {
  assert.deepEqual(extractProposedSelectors(`page.getByText(/Owner registered/).isVisible();`), []);
  assert.deepEqual(extractProposedSelectors(`page.getByLabel(/Owner name/).fill("x");`), []);
});

// ── Integration: extract + check ──────────────────────────────────────────────

test("end-to-end: extracted selector from spec checked against snapshot", () => {
  const spec = `await page.getByRole("button", { name: "Add Owner" }).click();`;
  const tree = ["button: Add Owner", "button: Cancel", "link: Home"];
  const sels = extractProposedSelectors(spec);
  assert.equal(sels.length, 1);
  const result = selectorPresent(sels[0]!, tree);
  assert.equal(result.present, true);
  assert.equal(result.verifiable, true);
  assert.equal(selectorUnique(sels[0]!, tree), true);
});

test("end-to-end: selector present in snapshot but non-unique flags strict-mode risk", () => {
  const spec = `await page.getByRole("textbox", { name: "Owner name" }).fill("John");`;
  // Post-creation duplicate: two textboxes with the same accessible name.
  const tree = ["textbox: Owner name", "textbox: Owner name"];
  const sels = extractProposedSelectors(spec);
  const result = selectorPresent(sels[0]!, tree);
  assert.equal(result.present, true);
  assert.equal(selectorUnique(sels[0]!, tree), false);
});

test("end-to-end: absent role is UNVERIFIABLE — never a hard failure", () => {
  // Bootstrap table: role="presentation" → no columnheader in the ariaSnapshot tree.
  const spec = `await page.getByRole("columnheader", { name: "Name" }).isVisible();`;
  const tree = ["text: Name", "text: Species"]; // no columnheader
  const sels = extractProposedSelectors(spec);
  const result = selectorPresent(sels[0]!, tree);
  assert.equal(result.present, false);
  assert.equal(result.verifiable, false); // UNVERIFIABLE — never blocks the spec
});

// ── selectorKey (stable structured identity) ──────────────────────────────────

test("selectorKey: same selector → same key; differing field → different key", () => {
  const a: ProposedSelector = { kind: "role", role: "heading", name: "Owners" };
  const b: ProposedSelector = { kind: "role", role: "heading", name: "Owners" };
  const c: ProposedSelector = { kind: "role", role: "heading", name: "Owners", exact: true };
  assert.equal(selectorKey(a), selectorKey(b));
  assert.notEqual(selectorKey(a), selectorKey(c));
});

// ── checkSpecSelectors (the reusable core, agnostic to the tree's SOURCE) ──────

test("checkSpecSelectors: present + non-unique WITHIN one tree → MULTIPLE contradiction", () => {
  const spec = `await page.getByRole("heading", { name: "Owners" }).click();`;
  const trees = [["heading: Owners", "heading: Owners"]]; // two matches in ONE tree
  const r = checkSpecSelectors([spec], trees);
  assert.equal(r.anyVerifiedPresent, true);
  assert.ok(r.contradictions.some((c) => c.includes("MULTIPLE")), "expected a strict-mode ambiguity contradiction");
  assert.equal(r.absentKeys.size, 0);
});

test("checkSpecSelectors: same name once in tree A and once in tree B → per-tree unique, NOT MULTIPLE", () => {
  const spec = `await page.getByRole("heading", { name: "Owners" }).click();`;
  const trees = [["heading: Owners"], ["heading: Owners"]]; // never fused across trees
  const r = checkSpecSelectors([spec], trees);
  assert.equal(r.anyVerifiedPresent, true);
  assert.equal(r.contradictions.some((c) => c.includes("MULTIPLE")), false);
});

test("checkSpecSelectors: verifiable-absent in every tree → absentKey + default 'failure-point' label", () => {
  const spec = `await page.getByRole("button", { name: "Ghost" }).click();`;
  const trees = [["button: Save"]]; // role present with a real name, name does not match
  const r = checkSpecSelectors([spec], trees);
  assert.equal(r.absentKeys.size, 1);
  assert.ok(r.contradictions.some((c) => c.includes("is NOT in the captured failure-point tree")));
});

test("checkSpecSelectors: treeLabel parameterizes the absent message (agnostic to tree source)", () => {
  const spec = `await page.getByRole("button", { name: "Ghost" }).click();`;
  const trees = [["button: Save"]];
  const r = checkSpecSelectors([spec], trees, "pre-write");
  assert.ok(r.contradictions.some((c) => c.includes("is NOT in the captured pre-write tree")));
});

test("checkSpecSelectors: a .locator(...) chain marks anyNonExtractable (scoped-locator guard)", () => {
  const spec = `await page.locator(".table").getByRole("row", { name: "John" }).click();`;
  const r = checkSpecSelectors([spec], [["row: John", "row: John"]]);
  assert.equal(r.anyNonExtractable, true);
});

test("checkSpecSelectors: role never in any tree → anyUnverifiable, no absent contradiction", () => {
  const spec = `await page.getByRole("columnheader", { name: "Name" }).isVisible();`;
  const trees = [["text: Name", "text: Species"]]; // no columnheader role at all
  const r = checkSpecSelectors([spec], trees);
  assert.equal(r.anyUnverifiable, true);
  assert.equal(r.absentKeys.size, 0);
  assert.equal(r.contradictions.length, 0);
});

test("checkSpecSelectors: no trees → empty findings (best-effort, never throws)", () => {
  const spec = `await page.getByRole("heading", { name: "Owners" }).click();`;
  const r = checkSpecSelectors([spec], []);
  assert.equal(r.contradictions.length, 0);
  assert.equal(r.anyVerifiedPresent, false);
});

// ── BLOCK-1 regression guard ──────────────────────────────────────────────────
// Confirms that checkSpecSelectors output is BYTE-IDENTICAL whether attrs is
// undefined or fully populated on the RouteSnapshot. selector-check.ts must
// consume only nodes[] (the "role: name" lines), never the attrs field.

test("BLOCK-1: checkSpecSelectors findings are byte-identical with attrs undefined vs populated", () => {
  // A nodes[] set that exercises both present and absent paths.
  const nodes = [
    "button: Submit",
    "link: Home",
    "textbox: (present)",
    "table: (present)",
    "cell: radiology",
  ];
  // Fully-populated attrs — selector-check must NOT see these.
  const attrs = [
    { key: "button: Submit", testId: "submit-btn" },
    { key: "link: Home", href: "/" },
    { key: "textbox: (present)", id: "q" },
  ];
  // Spec with both a present selector and a getByRole(button,{name:Submit,exact:true}).
  const spec = [
    `await page.getByRole("button", { name: "Submit", exact: true }).click();`,
    `await page.getByRole("link", { name: "Home" }).click();`,
    `await page.getByRole("heading", { name: "Absent" }).isVisible();`,
  ].join("\n");

  const withoutAttrs = checkSpecSelectors([spec], [nodes]);
  const withAttrs = checkSpecSelectors([spec], [nodes]); // attrs lives on RouteSnapshot, not passed to checkSpecSelectors
  // Findings must be identical whether we imagine attrs or not — selector-check never receives them.
  assert.deepEqual(withoutAttrs.contradictions, withAttrs.contradictions, "contradictions byte-identical");
  assert.deepEqual([...withoutAttrs.absentKeys], [...withAttrs.absentKeys], "absentKeys byte-identical");
  assert.equal(withoutAttrs.anyVerifiedPresent, withAttrs.anyVerifiedPresent, "anyVerifiedPresent byte-identical");
  assert.equal(withoutAttrs.anyNonExtractable, withAttrs.anyNonExtractable, "anyNonExtractable byte-identical");
});

test("BLOCK-1: getByRole(button,{name:Submit,exact:true}) yields present:true with exact match in nodes[]", () => {
  const nodes = ["button: Submit", "link: Home"];
  // With exact:true the name match is normActual === normExpected (no substring, no ci).
  // "Submit" === "Submit" → present:true.
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit", exact: true };
  const r = selectorPresent(sel, nodes);
  assert.equal(r.present, true, "exact Submit matches button: Submit");
  assert.equal(r.verifiable, true);
});

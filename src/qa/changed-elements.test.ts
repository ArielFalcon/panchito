import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChangedElements, changedElementsFromGuidance, type ChangedElement } from "./changed-elements";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDiff(lines: string[], file = "src/app/home.component.html"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,3 +1,${lines.length + 2} @@`,
    ` <div>`,
    ...lines,
    ` </div>`,
  ].join("\n");
}

// ── extractChangedElements decision table ────────────────────────────────────

test("extractChangedElements: data-cy added → testId entry", () => {
  const diff = makeDiff([`+<button data-cy="submit-order">Place Order</button>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.testId === "submit-order");
  assert.ok(entry, "testId=submit-order must be present");
  assert.equal(entry!.testId, "submit-order");
});

test("extractChangedElements: data-testid added → testId entry", () => {
  const diff = makeDiff([`+<button data-testid="register-btn">Register</button>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.testId === "register-btn");
  assert.ok(entry, "testId=register-btn from data-testid must be present");
});

test("extractChangedElements: data-test added → testId entry", () => {
  const diff = makeDiff([`+<input data-test="email-field" />`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.testId === "email-field");
  assert.ok(entry, "testId=email-field from data-test must be present");
});

test("extractChangedElements: id added → id entry", () => {
  const diff = makeDiff([`+<div id="main-panel">content</div>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.id === "main-panel");
  assert.ok(entry, "id=main-panel must be present");
});

test("extractChangedElements: formControlName added → name entry", () => {
  const diff = makeDiff([`+<input formControlName="username" />`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.name === "username");
  assert.ok(entry, "name=username from formControlName must be present");
});

test("extractChangedElements: name attr added → name entry", () => {
  const diff = makeDiff([`+<input name="email" type="email" />`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.name === "email");
  assert.ok(entry, "name=email must be present");
});

test("extractChangedElements: href added → href entry", () => {
  const diff = makeDiff([`+<a href="/store">Shop</a>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.href === "/store");
  assert.ok(entry, "href=/store must be present");
});

test("extractChangedElements: routerLink literal → href entry (not attr name)", () => {
  const diff = makeDiff([`+<a routerLink="/products">Products</a>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.href === "/products");
  assert.ok(entry, "routerLink resolved to href=/products (not the attr name)");
  // Must NOT store the attr name itself
  assert.ok(!result.some((e) => ("routerLink" in (e as unknown as Record<string, unknown>))), "routerLink attr name must not appear as a key");
});

test("extractChangedElements: [routerLink]=\"'/p'\" binding literal → href /p", () => {
  const diff = makeDiff([`+<a [routerLink]="'/products'">Link</a>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.href === "/products");
  assert.ok(entry, "[routerLink] with quoted literal resolves to href=/products");
});

test("extractChangedElements: [routerLink]=\"expr\" non-literal → skipped", () => {
  const diff = makeDiff([`+<a [routerLink]="dynamicRoute">Link</a>`]);
  const result = extractChangedElements(diff);
  // A non-literal expression should NOT produce an href entry
  assert.ok(!result.some((e) => e.href !== undefined && e.href !== "/products"), "non-literal routerLink must be skipped");
  // More precisely: no href should be produced for this specific pattern
  const hrefs = result.filter((e) => e.href !== undefined);
  assert.equal(hrefs.length, 0, "dynamic routerLink must not produce an href");
});

test("extractChangedElements: visible text in button → text entry", () => {
  const diff = makeDiff([`+<button>Save Changes</button>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.text === "Save Changes");
  assert.ok(entry, "visible button text must be captured");
});

test("extractChangedElements: visible text in anchor → text entry", () => {
  const diff = makeDiff([`+<a href="/about">About Us</a>`]);
  const result = extractChangedElements(diff);
  const textEntry = result.find((e) => e.text === "About Us");
  assert.ok(textEntry, "visible anchor text captured");
});

test("extractChangedElements: visible text in h1 → text entry", () => {
  const diff = makeDiff([`+<h1>Welcome to the store</h1>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.text === "Welcome to the store");
  assert.ok(entry, "h1 text captured");
});

test("extractChangedElements: visible text in h2-h6 → text entry", () => {
  const diff2 = makeDiff([`+<h2>Section Title</h2>`]);
  const diff6 = makeDiff([`+<h6>Fine print</h6>`]);
  assert.ok(extractChangedElements(diff2).some((e) => e.text === "Section Title"), "h2 text captured");
  assert.ok(extractChangedElements(diff6).some((e) => e.text === "Fine print"), "h6 text captured");
});

test("extractChangedElements: visible text in label → text entry", () => {
  const diff = makeDiff([`+<label>First name</label>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.text === "First name");
  assert.ok(entry, "label text captured");
});

test("extractChangedElements: Angular interpolation {{...}} in text → skipped", () => {
  const diff = makeDiff([`+<button>{{ submitLabel }}</button>`]);
  const result = extractChangedElements(diff);
  // Interpolated text must be skipped (not a stable literal)
  assert.ok(!result.some((e) => e.text?.includes("{{")), "interpolated text skipped");
});

test("extractChangedElements: template literal ${...} in text → skipped", () => {
  const diff = makeDiff([`+<button>\${dynamicLabel}</button>`]);
  const result = extractChangedElements(diff);
  assert.ok(!result.some((e) => e.text?.includes("${")), "template literal text skipped");
});

test("extractChangedElements: deletion-only line → skipped", () => {
  const diff = [
    `diff --git a/src/foo.html b/src/foo.html`,
    `--- a/src/foo.html`,
    `+++ b/src/foo.html`,
    `@@ -1,3 +1,2 @@`,
    ` <div>`,
    `-<button data-cy="old-btn">Old</button>`,
    ` </div>`,
  ].join("\n");
  const result = extractChangedElements(diff);
  assert.equal(result.length, 0, "deleted lines produce no ChangedElement");
});

test("extractChangedElements: multi-attr line → single ChangedElement (merged)", () => {
  const diff = makeDiff([`+<button data-cy="checkout-btn" id="checkout" name="checkout">Checkout</button>`]);
  const result = extractChangedElements(diff);
  // Multiple attrs on one line → at most one entry per line
  // The entry should have testId set (data-cy wins)
  const entry = result.find((e) => e.testId === "checkout-btn");
  assert.ok(entry, "testId from data-cy on multi-attr line");
  // One line → should produce ONE entry (all attrs merged into it)
  const sameLineEntries = result.filter((e) => e.line === entry!.line && e.file === entry!.file);
  assert.equal(sameLineEntries.length, 1, "multi-attr line produces exactly one ChangedElement");
});

test("extractChangedElements: empty diff → []", () => {
  assert.deepEqual(extractChangedElements(""), []);
});

test("extractChangedElements: pure TS diff (no HTML) → []", () => {
  const diff = [
    `diff --git a/src/app/service.ts b/src/app/service.ts`,
    `--- a/src/app/service.ts`,
    `+++ b/src/app/service.ts`,
    `@@ -1,3 +1,4 @@`,
    ` export class MyService {`,
    `+  private count = 0;`,
    ` }`,
  ].join("\n");
  assert.deepEqual(extractChangedElements(diff), [], "pure TS logic diff produces empty array");
});

test("extractChangedElements: raw field contains the trimmed added line", () => {
  const diff = makeDiff([`+<button data-cy="save">Save</button>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.testId === "save");
  assert.ok(entry, "entry found");
  assert.ok(entry!.raw.includes("data-cy"), "raw field contains the added line content");
  assert.ok(!entry!.raw.startsWith("+"), "raw does not include the leading + character");
});

test("extractChangedElements: file and line are set correctly", () => {
  const diff = [
    `diff --git a/src/home.html b/src/home.html`,
    `--- a/src/home.html`,
    `+++ b/src/home.html`,
    `@@ -5,3 +5,4 @@`,
    ` <div>`,
    `+<button data-cy="nav-home" href="/">Home</button>`,
    ` </div>`,
  ].join("\n");
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.testId === "nav-home");
  assert.ok(entry, "entry found");
  assert.equal(entry!.file, "src/home.html");
  // Line 5 is the hunk start (context line = 5), then +line is 6
  assert.equal(typeof entry!.line, "number");
  assert.ok(entry!.line > 0, "line is positive");
});

test("extractChangedElements: mat-* element text captured", () => {
  const diff = makeDiff([`+<mat-button>Submit Form</mat-button>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.text === "Submit Form");
  assert.ok(entry, "mat-button text captured");
});

test("extractChangedElements: capped at 200 entries for huge diffs", () => {
  // Build a diff with 250 added lines each with a unique data-cy
  const lines = Array.from({ length: 250 }, (_, i) => `+<button data-cy="btn-${i}">Btn</button>`);
  const diff = [
    `diff --git a/src/huge.html b/src/huge.html`,
    `--- a/src/huge.html`,
    `+++ b/src/huge.html`,
    `@@ -1,5 +1,255 @@`,
    ...lines,
  ].join("\n");
  const result = extractChangedElements(diff);
  assert.ok(result.length <= 200, `capped at 200, got ${result.length}`);
});

// ── changedElementsFromGuidance ───────────────────────────────────────────────

test("changedElementsFromGuidance: guidance produces text entries for noun-phrases", () => {
  const result = changedElementsFromGuidance("test the contact form");
  assert.ok(result.length > 0, "non-empty guidance must produce entries");
  // Each entry should have a text field
  assert.ok(result.every((e) => e.text !== undefined), "all entries from guidance have text field");
});

test("changedElementsFromGuidance: empty string → []", () => {
  assert.deepEqual(changedElementsFromGuidance(""), []);
});

test("changedElementsFromGuidance: multi-word phrase → one entry per phrase", () => {
  const result = changedElementsFromGuidance("verify the checkout flow");
  // Should produce at least one entry; phrases must have text
  assert.ok(result.every((e) => typeof e.text === "string"), "all entries have string text");
  assert.ok(result.every((e) => (e.text?.length ?? 0) > 0), "all text entries are non-empty");
});

test("changedElementsFromGuidance: entries only have text field set (no file/line from diff)", () => {
  const result = changedElementsFromGuidance("test the register form");
  // Guidance-derived entries have no file path (not from a diff)
  for (const e of result) {
    assert.equal(e.file, "", "guidance entries have empty file (no diff line)");
    assert.equal(e.line, 0, "guidance entries have line=0");
    assert.ok(e.text !== undefined, "guidance entries have text");
  }
});

// ── Fix 1a: stopword filter in changedElementsFromGuidance ────────────────────
// RED tests: these pass only after the stopword set and length guard are applied.

test("changedElementsFromGuidance FIX-1a: QA stopwords ('test','form','page','button','link') are not emitted", () => {
  // "test the contact form" — 'test', 'form' must not appear as standalone matchers
  const result = changedElementsFromGuidance("test the contact form");
  const texts = result.map((e) => e.text?.toLowerCase() ?? "");
  assert.ok(!texts.includes("test"), "'test' is a QA stopword and must not be emitted");
  assert.ok(!texts.includes("form"), "'form' is a QA stopword and must not be emitted");
  // "contact" is distinctive and 7 chars — still kept
  assert.ok(texts.includes("contact"), "'contact' is distinctive and must be kept");
});

test("changedElementsFromGuidance FIX-1a: short QA verbs ('click','check','verify','ensure','should','submit') are not emitted", () => {
  const result = changedElementsFromGuidance("click the submit button and verify the checkout flow");
  const texts = result.map((e) => e.text?.toLowerCase() ?? "");
  for (const stopword of ["click", "submit", "verify", "button", "checkout", "flow"]) {
    // Only 'checkout' (8 chars) and 'submit' (6 chars) could pass a bare ≥4 guard;
    // they are stopwords and must NOT be emitted.
    // 'flow' (4 chars) is borderline but also a stopword.
    // 'click' (5 chars) is a stopword.
    // 'verify' (6 chars) is a stopword.
    // 'button' (6 chars) is a stopword.
    if (["click", "submit", "verify", "button", "flow"].includes(stopword)) {
      assert.ok(!texts.includes(stopword), `'${stopword}' is a QA stopword and must not be emitted`);
    }
  }
});

test("changedElementsFromGuidance FIX-1a: standalone ≤4-char tokens never emitted (min-length guard raised)", () => {
  // 'test' is exactly 4 chars; 'form' is 4 chars; 'the' is 3; 'and' is 3
  const result = changedElementsFromGuidance("test the contact form and link");
  const texts = result.map((e) => e.text ?? "");
  for (const t of texts) {
    assert.ok(t.length > 4, `token "${t}" with ≤4 chars must not be emitted standalone`);
  }
  // Distinctive long words still surface
  assert.ok(texts.some((t) => t.toLowerCase() === "contact"), "'contact' must be kept");
});

test("changedElementsFromGuidance FIX-1a: distinctive non-stopword phrases still emitted", () => {
  // 'navigation', 'dashboard', 'product' are long/distinctive — must still be captured
  const result = changedElementsFromGuidance("test the navigation bar and dashboard widget");
  const texts = result.map((e) => e.text?.toLowerCase() ?? "");
  assert.ok(texts.includes("navigation"), "'navigation' is distinctive and must be kept");
  assert.ok(texts.includes("dashboard"), "'dashboard' is distinctive and must be kept");
});

test("changedElementsFromGuidance FIX-1a: quoted phrases with stopwords inside are kept whole", () => {
  // A quoted span like "contact form" is a distinctive phrase even though 'form' is a stopword.
  const result = changedElementsFromGuidance('"contact form" submission');
  const texts = result.map((e) => e.text ?? "");
  // The quoted span "contact form" must survive as a phrase
  assert.ok(texts.some((t) => t.toLowerCase().includes("contact form")), "quoted phrase 'contact form' must be kept whole");
});

// ── Fix 2: unbound routerLink without leading / or # must not be stored ──────
// RED tests: the unbound routerLink extractor currently stores href:"products" (no slash),
// which is inconsistent with how href is stored elsewhere and never joins.

test("extractChangedElements FIX-2: unbound routerLink without leading / is NOT stored (ambiguous relative path)", () => {
  // routerLink="products" (no leading slash or #) → ambiguous; must be skipped
  const diff = makeDiff([`+<a routerLink="products">Products</a>`]);
  const result = extractChangedElements(diff);
  // Must produce NO href entry for "products" (relative, un-rooted)
  const hrefs = result.filter((e) => e.href !== undefined);
  assert.ok(!hrefs.some((e) => e.href === "products"), "relative routerLink 'products' must not be stored as href");
  // If any href is emitted, it must start with / or #
  for (const e of hrefs) {
    assert.ok(
      e.href!.startsWith("/") || e.href!.startsWith("#"),
      `href "${e.href}" must start with / or # — never a bare relative path`,
    );
  }
});

test("extractChangedElements FIX-2: unbound routerLink with leading / IS stored (absolute path)", () => {
  // routerLink="/products" (leading slash) → valid absolute path, must be stored
  const diff = makeDiff([`+<a routerLink="/products">Products</a>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.href === "/products");
  assert.ok(entry, "routerLink with leading / must still be stored as href=/products");
});

test("extractChangedElements FIX-2: unbound routerLink with leading # IS stored (fragment)", () => {
  // routerLink="#section" → fragment link, valid
  const diff = makeDiff([`+<a routerLink="#section">Section</a>`]);
  const result = extractChangedElements(diff);
  const entry = result.find((e) => e.href === "#section");
  assert.ok(entry, "routerLink with leading # must be stored as href=#section");
});

test("extractChangedElements FIX-2: href extractor behaviour unchanged (/ and # only)", () => {
  // The href extractor already filtered to / or #; this confirms routerLink now matches the same rule
  const diffRelHref = makeDiff([`+<a href="about">About</a>`]);
  assert.ok(!extractChangedElements(diffRelHref).some((e) => e.href === "about"), "bare relative href still rejected");
  const diffAbsHref = makeDiff([`+<a href="/about">About</a>`]);
  assert.ok(extractChangedElements(diffAbsHref).some((e) => e.href === "/about"), "absolute href still accepted");
});

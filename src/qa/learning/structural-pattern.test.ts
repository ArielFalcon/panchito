import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStructuralPatterns } from "./structural-pattern";

// sdd/migration-wiring-phase-2 Slice 4 (D-E skill-exemplar restore): this file was deleted in Phase 1
// as dead code (zero production callers — no caller ever threaded detectStructuralPatterns' output
// anywhere). Restored VERBATIM (git history: 3b59b90^) because this slice gives it a genuine caller —
// the generation prompt's new "skill-exemplars" section (src/integrations/prompts.ts), fed via
// OpencodeRunInput.structuralPatterns. These are the FIRST dedicated tests this function has ever had.

test("detectStructuralPatterns: an HTML form diff detects a 'form' pattern", () => {
  const diff = "diff --git a/src/checkout.html b/src/checkout.html\n+<form onsubmit=\"submit()\">\n+  <input required minlength=\"3\" />\n+</form>\n";
  const patterns = detectStructuralPatterns(diff, ["src/checkout.html"]);
  const form = patterns.find((p) => p.kind === "form");
  assert.ok(form, "must detect a form pattern");
  assert.deepEqual(form, { kind: "form", hasOnSubmit: true, hasValidation: true });
});

test("detectStructuralPatterns: a TSX form without validation detects hasValidation:false", () => {
  const diff = "diff --git a/src/Checkout.tsx b/src/Checkout.tsx\n+<FormGroup>\n+  <input name=\"email\" />\n+</FormGroup>\n";
  const patterns = detectStructuralPatterns(diff, ["src/Checkout.tsx"]);
  const form = patterns.find((p) => p.kind === "form");
  assert.ok(form);
  assert.deepEqual(form, { kind: "form", hasOnSubmit: true, hasValidation: false });
});

test("detectStructuralPatterns: an API call diff with error handling detects an 'api-call' pattern", () => {
  const diff = "diff --git a/src/api.ts b/src/api.ts\n+fetch('/orders', { method: 'POST', body: payload })\n+  .catch((error) => { if (!response.ok) throw error; })\n";
  const patterns = detectStructuralPatterns(diff, ["src/api.ts"]);
  const api = patterns.find((p) => p.kind === "api-call");
  assert.ok(api, "must detect an api-call pattern");
  assert.deepEqual(api, { kind: "api-call", method: "POST", hasRequestBody: true, hasErrorHandling: true });
});

test("detectStructuralPatterns: a cache-related diff detects a 'stateful-cache' pattern", () => {
  const diff = "diff --git a/src/store.ts b/src/store.ts\n+const cached = memoize(fetchOrders);\n+function invalidate() { cache.clear(); }\n";
  const patterns = detectStructuralPatterns(diff, ["src/store.ts"]);
  const cache = patterns.find((p) => p.kind === "stateful-cache");
  assert.ok(cache, "must detect a stateful-cache pattern");
  assert.equal(cache?.kind, "stateful-cache");
  assert.equal((cache as { hasIndependentWritePath: boolean }).hasIndependentWritePath, true);
});

test("detectStructuralPatterns: an auth-related diff detects an 'auth-flow' pattern", () => {
  const diff = "diff --git a/src/login.ts b/src/login.ts\n+function login(username, password) {\n+  const token = issueJwt(username);\n+}\n";
  const patterns = detectStructuralPatterns(diff, ["src/login.ts"]);
  const auth = patterns.find((p) => p.kind === "auth-flow");
  assert.ok(auth, "must detect an auth-flow pattern");
  assert.deepEqual(auth, { kind: "auth-flow", hasLogin: true, hasSessionToken: true });
});

test("detectStructuralPatterns: a list-related diff detects a 'data-list' pattern", () => {
  const diff = "diff --git a/src/OwnersList.tsx b/src/OwnersList.tsx\n+const results = items.filter((i) => i.active);\n+// pagination: offset-based\n";
  const patterns = detectStructuralPatterns(diff, ["src/OwnersList.tsx"]);
  const list = patterns.find((p) => p.kind === "data-list");
  assert.ok(list, "must detect a data-list pattern");
});

test("detectStructuralPatterns: a diff matching NO known shape returns a single 'generic' pattern", () => {
  const diff = "diff --git a/src/util.ts b/src/util.ts\n+export function add(a: number, b: number) { return a + b; }\n";
  const patterns = detectStructuralPatterns(diff, ["src/util.ts"]);
  assert.deepEqual(patterns, [{ kind: "generic" }]);
});

test("detectStructuralPatterns: a diff touching multiple shapes returns multiple patterns (never just the first match)", () => {
  const diff = [
    "diff --git a/src/CheckoutForm.tsx b/src/CheckoutForm.tsx",
    "+<FormGroup onSubmit={submit}>",
    "+  <input required />",
    "+</FormGroup>",
    "+fetch('/checkout', { method: 'POST', body: payload }).catch((error) => { if (!response.ok) throw error; });",
  ].join("\n");
  const patterns = detectStructuralPatterns(diff, ["src/CheckoutForm.tsx"]);
  const kinds = patterns.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["api-call", "form"]);
});

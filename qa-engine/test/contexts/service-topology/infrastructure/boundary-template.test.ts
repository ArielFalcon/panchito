// test/contexts/service-topology/infrastructure/boundary-template.test.ts
// TDD (strict): the template compiler turns a config-supplied "{service}" template into a
// matcher — this is what lets servicePrefixTemplate / serviceRepoTemplate be app config
// instead of a hardcoded regex in the core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePrefixTemplate, compileRepoTemplate } from "@contexts/service-topology/infrastructure/boundary-template.ts";

// ---- compilePrefixTemplate: "name-{service}-api" style (path prefix + trailing resource) ----

test("compilePrefixTemplate: matches the nname convention 'name-{service}-api' and extracts service + resource", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("name-orders-api/orders");
  assert.ok(m);
  assert.equal(m?.service, "orders");
  assert.equal(m?.resource, "orders");
});

test("compilePrefixTemplate: accepts an optional leading slash", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("/name-orders-api/orders");
  assert.ok(m);
  assert.equal(m?.service, "orders");
});

test("compilePrefixTemplate: accepts digits in the service name (auth-v2)", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("name-auth-v2-api/login");
  assert.ok(m);
  assert.equal(m?.service, "auth-v2");
  assert.equal(m?.resource, "login");
});

test("compilePrefixTemplate: trailing resource defaults to empty string when absent", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("name-orders-api");
  assert.ok(m);
  assert.equal(m?.service, "orders");
  assert.equal(m?.resource, "");
});

test("compilePrefixTemplate: returns null for a path that does not match the template", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  assert.equal(matcher("something-else/orders"), null);
});

test("compilePrefixTemplate: a DIFFERENT template shape ('{service}-service') works with the SAME compiler", () => {
  // Proves the compiler is not tied to the nname prefix/suffix shape — a suffix-only template
  // from a different app's config compiles and matches correctly.
  const matcher = compilePrefixTemplate("{service}-service");
  const m = matcher("orders-service/orders");
  assert.ok(m);
  assert.equal(m?.service, "orders");
  assert.equal(m?.resource, "orders");
});

// ---- compileRepoTemplate: "ms-name-{service}" style (repo slug → service name) ----

test("compileRepoTemplate: matches the nname convention 'ms-name-{service}' and extracts service", () => {
  const matcher = compileRepoTemplate("ms-name-{service}");
  assert.equal(matcher("ms-name-orders"), "orders");
});

test("compileRepoTemplate: returns the original slug unchanged when the template does not match", () => {
  const matcher = compileRepoTemplate("ms-name-{service}");
  assert.equal(matcher("some-other-repo"), "some-other-repo");
});

test("compileRepoTemplate: a DIFFERENT template shape works with the SAME compiler (agnosticism)", () => {
  const matcher = compileRepoTemplate("svc-{service}-repo");
  assert.equal(matcher("svc-orders-repo"), "orders");
});

// ---- Fix #3: templates need EXACTLY one "{service}" token — 0 or 2+ must warn + fail-CLOSED ----
// indexOf finds only the FIRST "{service}"; with 2+ placeholders the rest is matched as a
// literal string (near-never matches — silently useless); with 0 placeholders the "empty
// suffix" degenerates into a phantom capture group that can swallow real characters as a
// fabricated service name (see the compilePrefixTemplate phantom-capture test below).

test("compilePrefixTemplate: a template with TWO '{service}' tokens warns and always returns null (fail-closed)", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const matcher = compilePrefixTemplate("name-{service}-{service}-api");
    assert.equal(matcher("name-orders-orders-api/x"), null, "must fail-closed, never match");
    assert.equal(matcher("anything"), null);
    assert.ok(warnings.length > 0, "must warn about the unsupported multi-placeholder template");
  } finally {
    console.warn = originalWarn;
  }
});

test("compilePrefixTemplate: a template with NO '{service}' token warns and always returns null (fail-closed)", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const matcher = compilePrefixTemplate("no-placeholder");
    assert.equal(matcher("no-placeholder/x"), null, "must fail-closed, never match");
    assert.equal(matcher("no-placeholderZZZ/x"), null, "must NOT phantom-capture 'Z' as a fabricated service");
  } finally {
    console.warn = originalWarn;
  }
});

test("compilePrefixTemplate: a template with exactly ONE '{service}' token still works (no false-positive warn)", () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const matcher = compilePrefixTemplate("name-{service}-api");
    const m = matcher("name-orders-api/orders");
    assert.ok(m);
    assert.equal(m?.service, "orders");
    assert.equal(warned, false, "a valid single-placeholder template must not warn");
  } finally {
    console.warn = originalWarn;
  }
});

test("compileRepoTemplate: a template with TWO '{service}' tokens warns and always returns the raw slug (fail-closed)", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const matcher = compileRepoTemplate("ms-{service}-{service}");
    assert.equal(matcher("ms-orders-orders"), "ms-orders-orders", "fail-closed: return slug unchanged");
    assert.ok(warnings.length > 0, "must warn about the unsupported multi-placeholder template");
  } finally {
    console.warn = originalWarn;
  }
});

test("compileRepoTemplate: a template with NO '{service}' token warns and always returns the raw slug (fail-closed, no phantom capture)", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const matcher = compileRepoTemplate("no-placeholder");
    assert.equal(matcher("no-placeholderXYZ"), "no-placeholderXYZ", "must NOT phantom-capture 'XYZ' as a fabricated service");
  } finally {
    console.warn = originalWarn;
  }
});

// ---- Fix #4: the prefix template's trailing suffix must end on a segment boundary ----
// Before this fix, the suffix matched as a substring, so "name-{service}-api" would match
// "name-orders-apifoo" (bogus: {service: orders, resource: foo}) because the SERVICE_CHARSET
// includes "-" and nothing enforced a "/" or end-of-string right after the literal suffix.

test("compilePrefixTemplate: the suffix must be followed by a '/' or end-of-string, not swallow trailing chars", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  assert.equal(
    matcher("name-orders-apifoo"),
    null,
    "no segment boundary after the suffix — must NOT match",
  );
});

test("compilePrefixTemplate: suffix followed by '/' + resource still matches (boundary preserved)", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("name-orders-api/resource");
  assert.ok(m);
  assert.equal(m?.service, "orders");
  assert.equal(m?.resource, "resource");
});

test("compilePrefixTemplate: suffix at end-of-string (bare, no resource) still matches (boundary preserved)", () => {
  const matcher = compilePrefixTemplate("name-{service}-api");
  const m = matcher("name-orders-api");
  assert.ok(m);
  assert.equal(m?.service, "orders");
  assert.equal(m?.resource, "");
});

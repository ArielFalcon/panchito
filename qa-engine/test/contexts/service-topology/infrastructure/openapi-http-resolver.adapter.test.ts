// test/contexts/service-topology/infrastructure/openapi-http-resolver.adapter.test.ts
// TDD (strict): write failing tests first, then implement.
// Uses tiny fixtures, no real repo dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { OpenApiHttpResolver, extractEnclosingMethodFallback } from "@contexts/service-topology/infrastructure/openapi-http-resolver.adapter.ts";
import type { RepoRef, ServiceLink, ContractDrift, HttpBoundaryProfile } from "@contexts/service-topology/domain/index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

// The real nname system's HTTP boundary convention, as an injected config object — NOT
// core constants. Every existing fixture under fixtures/{backend*,frontend*} encodes this
// exact convention, so this profile must keep them all green (Invariant #1: the resolver
// itself carries zero nname literal; this profile is the ONLY place nname-shaped values live
// in this test file).
const NNAME_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

// ---- Fixture layout ----
// test/contexts/service-topology/fixtures/
//   backend/
//     src/main/resources/openapi/api-definition.yaml   (tiny: GET /orders, GET /orders/{id})
//   frontend/
//     src/app/orders/api/orders.api.ts                 (calls this.rest.get(...)
//                                                        incl. multiline chain + hardcoded param)

const backendRepo: RepoRef = {
  repo: "ArielFalcon/ms-name-orders",
  mirrorDir: join(FIXTURES, "backend"),
};
const frontendRepo: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend"),
};

// ---- (a) matched ServiceLink with correct operationId ----
test("resolveLinks: matched call produces a ServiceLink with correct operationId as contractRef", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "listOrders" && l.transport === "http",
  );
  assert.ok(link, "expected a matched ServiceLink with contractRef=listOrders");
  assert.equal(link.from.repo, frontendRepo.repo);
  assert.equal(link.to.repo, backendRepo.repo);
  assert.equal(link.confidence, 1);
  assert.equal(link.source, "openapi-http");
});

// ---- (b) drift: front calls endpoint the contract does not declare ----
test("resolveLinks: drift finding appears in result.drift when front calls undeclared endpoint", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  const drift = result.drift.find(
    (d: ContractDrift) => d.verb === "POST" && d.path.includes("orders"),
  );
  assert.ok(drift, "expected a ContractDrift for POST /name-orders-api/orders (undeclared in contract)");
});

// ---- (c) external / unknown-service call is bucketed separately ----
test("resolveLinks: call to an unknown service prefix goes to result.external", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  // fixture has a call to name-unknown-api/... — not in the repo set
  const ext = result.external.find(
    (e: { path: string }) => e.path.includes("name-unknown-api"),
  );
  assert.ok(ext, "expected an external bucket entry for name-unknown-api call");
});

// ---- (d) dynamic/unresolvable arg is bucketed as unresolved ----
test("resolveLinks: dynamic (method-param) arg goes to result.unresolved", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  assert.ok(result.unresolved.length > 0, "expected at least one unresolved call-site from a dynamic arg");
});

// ---- (e) multiline chained call is also matched ----
test("resolveLinks: multiline this.rest\\n  .get(...) chained call is matched", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "getOrderById" && l.transport === "http",
  );
  assert.ok(link, "expected a matched ServiceLink for the multiline-chained get(id) call with contractRef=getOrderById");
});

// ---- Fail-open: missing OpenAPI file degrades gracefully ----
test("resolveLinks: when backend OpenAPI file is missing, returns empty result without throwing", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const missingBackend: RepoRef = { repo: "ArielFalcon/nonexistent", mirrorDir: "/nonexistent/path" };
  const result = await resolver.resolveLinks([missingBackend], frontendRepo);
  assert.equal(result.links.length, 0);
  // drift/external/unresolved may still come from the frontend egress that couldn't be matched
});

// ---- Fix 1: resolveArg uses indexOf (first closing quote), not lastIndexOf ----
// A quoted arg followed by options object: `'name-x-api/p', { auth: 'client' }`.
// CALL_RE stops at the first comma so the captured group is `'name-x-api/p'` (no trailing chars).
// But defensive correctness: if the quote were trimmed, lastIndexOf returns -1 and drops the last char.
// This fixture proves indexOf(q,1) gives the right result for a clean quoted arg (regression guard).
const ambiguousBackend: RepoRef = { repo: "ArielFalcon/ms-name-x", mirrorDir: join(FIXTURES, "backend") };
const ambiguousFront: RepoRef = { repo: "ArielFalcon/name-webapp", mirrorDir: join(FIXTURES, "frontend-fix1") };
test("resolveArg: quoted path arg resolves to correct path (indexOf, not lastIndexOf)", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  // frontend-fix1 fixture has: this.rest.get('name-x-api/p', { auth: 'client' })
  // CALL_RE captures only `'name-x-api/p'` as the first arg (stops at comma).
  // indexOf('\'', 1) = 12, so slice(1,12) = "name-x-api/p" — correct.
  // lastIndexOf would also = 12 here. The real risk is a trimmed arg like `'path` (no closing quote).
  // We test the normal case as a regression guard; the defensive path is in the impl comment.
  const result = await resolver.resolveLinks([ambiguousBackend], ambiguousFront);
  // Should NOT produce an unresolved entry for this call (path was resolvable)
  const hasUnresolvedForP = result.unresolved.some((u) => u.rawArg.includes("name-x-api/p"));
  assert.equal(hasUnresolvedForP, false, "quoted path arg with trailing options should resolve, not land in unresolved");
  // The path resolves but name-x-api/p has no matching op → goes to external (no service in system) or drift
  const found = [...result.links, ...result.drift, ...result.external].some(
    (e) => JSON.stringify(e).includes("name-x-api"),
  );
  assert.ok(found, "resolved path should appear in links, drift, or external — not be lost");
});

// ---- Fix 3: findOp prefers exact all-literal match over a param match ----
// Contract has /orders/active (literal) AND /orders/{id} (param at same slot).
// Front calls /orders/active → should resolve to the literal op (getActiveOrders).
// Front calls /orders/abc123 → should resolve to the param op (getOrderById).
const literalBackend: RepoRef = {
  repo: "ArielFalcon/ms-name-orders",
  mirrorDir: join(FIXTURES, "backend-literal"),
};
const literalFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-literal"),
};

test("findOp: /orders/active resolves to literal op getActiveOrders (not the {id} param op)", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([literalBackend], literalFront);
  const activeLink = result.links.find((l: ServiceLink) => l.contractRef === "getActiveOrders");
  assert.ok(activeLink, "expected getActiveOrders for the literal /orders/active path");
});

test("findOp: /orders/abc123 resolves to param op getOrderById (not the literal op)", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([literalBackend], literalFront);
  const paramLink = result.links.find((l: ServiceLink) => l.contractRef === "getOrderById");
  assert.ok(paramLink, "expected getOrderById for the concrete /orders/abc123 path (matched by {id} param)");
});

// ==========================================
// LEVEL 2 — from.symbol = enclosingMethod name (tree-sitter, not backward scan)
// ==========================================

// L2-rxjs: methods with RxJS pipe() chains.
// The backward-scan heuristic picks up operators from inside .pipe() —
// tree-sitter AST walk must stop at the enclosing method_definition.
const rxjsBackend: RepoRef = {
  repo: "ArielFalcon/ms-name-restaurants",
  mirrorDir: join(FIXTURES, "backend-restaurants"),
};
const rxjsFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-rxjs"),
};

test("L2-rxjs: from.symbol for getAllRestaurants() is 'getAllRestaurants', NOT 'catchError' or 'switchMap'", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([rxjsBackend], rxjsFront);
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "getAllRestaurants",
  );
  assert.ok(link, "expected a link for getAllRestaurants");
  assert.equal(
    link.from.symbol,
    "getAllRestaurants",
    `expected from.symbol='getAllRestaurants', got '${link.from.symbol}' — backward scan incorrectly picked up an RxJS operator`,
  );
});

test("L2-rxjs: from.symbol for createNewDailyMenu() is 'createNewDailyMenu', NOT 'toString'", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([rxjsBackend], rxjsFront);
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "createNewDailyMenu",
  );
  assert.ok(link, "expected a link for createNewDailyMenu");
  assert.equal(
    link.from.symbol,
    "createNewDailyMenu",
    `expected from.symbol='createNewDailyMenu', got '${link.from.symbol}' — backward scan incorrectly picked up a nested call`,
  );
});

test("L2-rxjs: from.symbol for findNearbyPlaces() is 'findNearbyPlaces', NOT 'catchError'", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([rxjsBackend], rxjsFront);
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "findNearbyPlaces",
  );
  assert.ok(link, "expected a link for findNearbyPlaces");
  assert.equal(
    link.from.symbol,
    "findNearbyPlaces",
    `expected from.symbol='findNearbyPlaces', got '${link.from.symbol}' — backward scan incorrectly picked up a pipe operator`,
  );
});

// The existing fixture has two named methods (listOrders, getOrderById).
// from.symbol should be the enclosing method/function name, NOT the raw path arg.
test("L2: from.symbol on a link is the enclosing method name, not the raw path arg", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  // listOrders() calls this.rest.get(`${BASE_PATH}/orders`) → should link to listOrders operationId
  // from.symbol should be "listOrders" (the enclosing method name), not the raw arg
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "listOrders",
  );
  assert.ok(link, "expected a link for listOrders");
  assert.equal(
    link.from.symbol,
    "listOrders",
    `expected from.symbol to be the enclosing method name "listOrders", got "${link.from.symbol}"`,
  );
});

test("L2: from.symbol for a second method in the same file is its own enclosing method name", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);
  // getOrderById() calls this.rest.get(`${BASE_PATH}/orders/abc123`) → should link to getOrderById op
  const link = result.links.find(
    (l: ServiceLink) => l.contractRef === "getOrderById",
  );
  assert.ok(link, "expected a link for getOrderById");
  assert.equal(
    link.from.symbol,
    "getOrderById",
    `expected from.symbol to be the enclosing method name "getOrderById", got "${link.from.symbol}"`,
  );
});

// ==========================================
// LEVEL 1 CORRECTNESS FIXES (RED → GREEN)
// ==========================================

// ---- L1.1: {p} partial-resolution → reduced confidence ----
// A template literal `${BASE}/orders/${methodParam}` where BASE is a const (resolved)
// and methodParam is a method argument (unresolved → {p}).
// The resolved path is "name-orders-api/orders/{p}".
// The structural match against /orders/{id} succeeds (contract {id} absorbs {p}).
// BUT the match consumed a {p} segment — this is NOT a pure literal match.
// Expected: confidence < 1.0 (not 1.0).
// The fully-literal call (listOrders: name-orders-api/orders) MUST remain at 1.0.
const mixedParamBackend: RepoRef = {
  repo: "ArielFalcon/ms-name-orders",
  mirrorDir: join(FIXTURES, "backend"),
};
const mixedParamFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-mixed-param"),
};

test("L1.1: mixed-param template (BASE+methodParam) match yields reduced confidence, not 1.0", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([mixedParamBackend], mixedParamFront);
  // The getOrderDynamic call: `${BASE}/orders/${methodParam}` → name-orders-api/orders/{p}
  // Matched against /orders/{id} where {id} absorbs {p} → should have confidence < 1.0
  const mixedLink = result.links.find(
    (l: ServiceLink) => l.contractRef === "getOrderById",
  );
  assert.ok(mixedLink, "expected a link for the mixed-param template call");
  assert.ok(
    mixedLink.confidence < 1.0,
    `expected confidence < 1.0 for a {p}-consuming match, got ${mixedLink.confidence}`,
  );
});

test("L1.1: fully-literal match (no {p} segments) keeps confidence 1.0", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([mixedParamBackend], mixedParamFront);
  // The listOrders call: `${BASE}/orders` → name-orders-api/orders — purely literal match
  const literalLink = result.links.find(
    (l: ServiceLink) => l.contractRef === "listOrders",
  );
  assert.ok(literalLink, "expected a link for the fully-literal listOrders call");
  assert.equal(literalLink.confidence, 1.0, "fully-literal match must be confidence 1.0");
});

// ---- L1.2: SERVICE_PREFIX_RE accepts digits and optional leading slash ----
// name-auth-v2-api/login → service "auth-v2" (has digit in name)
// /name-orders-api/orders → leading slash (optional)
const authV2Backend: RepoRef = {
  repo: "ArielFalcon/ms-name-auth-v2",
  mirrorDir: join(FIXTURES, "backend-v2"),
};
const authV2Front: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-v2"),
};
const leadingSlashFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-leading-slash"),
};

test("L1.2: SERVICE_PREFIX_RE accepts service names with digits (e.g. auth-v2)", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([authV2Backend], authV2Front);
  // name-auth-v2-api/login → should classify against auth-v2 service
  // The login op is in the backend-v2 contract → should produce a link or drift (not unresolved)
  const hasClassified = result.links.length > 0 || result.drift.length > 0 || result.external.length > 0;
  assert.ok(hasClassified, "name-auth-v2-api/login should be classified (not land in unresolved)");
});

test("L1.2: SERVICE_PREFIX_RE accepts optional leading slash on the path", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([mixedParamBackend], leadingSlashFront);
  // /name-orders-api/orders (leading slash) → should classify as orders service, not unresolved
  const hasClassified = result.links.length > 0 || result.drift.length > 0;
  assert.ok(hasClassified, "/name-orders-api/orders (leading slash) should be classified, not unresolved");
  // Specifically it should link to listOrders (GET /orders exists in backend)
  const link = result.links.find((l: ServiceLink) => l.contractRef === "listOrders");
  assert.ok(link, "expected link to listOrders from /name-orders-api/orders with leading slash");
});

// ---- L1.3: dedup loses from.file — two files calling the same undeclared endpoint ----
// Two front files (alpha.api.ts, beta.api.ts) both call POST name-orders-api/orders.
// POST /orders is NOT in the backend contract → two drift entries.
// The composite drift dedup key MUST include from.file so both entries survive even when
// two resolvers independently surface the same verb+path from different source files.
const multiDriftFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-multi-drift"),
};

test("L1.3: two front files calling the same undeclared endpoint produce two drift entries", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([mixedParamBackend], multiDriftFront);
  // alpha.api.ts and beta.api.ts both call POST name-orders-api/orders (undeclared in contract)
  // Each produces its own drift entry (different from.file) — both should survive
  const postOrdersDrift = result.drift.filter(
    (d: ContractDrift) => d.verb === "POST" && d.path.includes("orders"),
  );
  assert.equal(
    postOrdersDrift.length,
    2,
    `expected 2 drift entries (one per source file), got ${postOrdersDrift.length}`,
  );
  // Each entry must have a different from.file
  const files = postOrdersDrift.map((d: ContractDrift) => d.from.file);
  assert.notEqual(files[0], files[1], "the two drift entries must have different from.file values");
});

// ---- L1.5: string-concat path arg → unresolved, not drift ----
// 'name-x-api/' + v + '/p' is a binary concatenation expression.
// resolveArg sees a bare identifier or a non-quoted non-template arg.
// It cannot resolve it statically → should land in unresolved, NOT drift.
const concatFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-concat"),
};

// ==========================================
// ROUND 2 FINDINGS (RED → GREEN)
// ==========================================

// ---- R2-F1: walkUpToMethod — top-level const arrow not handled ----
// `export const listOrders = () => this.rest.get(...)` — tree-sitter AST:
//   lexical_declaration → variable_declarator[identifier "listOrders", arrow_function]
// arrow_function has no name child. The identifier lives in the sibling variable_declarator.
// walkUpToMethod must check parent.type === "variable_declarator" and extract its identifier child.
const constArrowFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-const-arrow"),
};

// ---- R2-F2: resolveVal `seen` Set shared across sibling substitutions ----
// `${API}/${API}` where API = 'name-orders-api'.
// Bug: first ${API} adds 'API' to `seen`; second ${API} hits the guard and substitutes {p}.
// Fix: in resolveArg, pass a fresh new Set() per top-level resolveVal call so siblings don't
// share cycle-state. The `seen` Set is a cycle-guard (prevent infinite recursion), not a
// "already-resolved" cache.
const repeatedConstFront: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend-repeated-const"),
};

test("R2-F2: repeated const reference in template literal resolves both occurrences (no {p})", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  // API = 'name-orders-api', template is `${API}/${API}` → should be 'name-orders-api/name-orders-api'.
  // With the bug the second ${API} becomes {p}, giving 'name-orders-api/{p}' which is different.
  const result = await resolver.resolveLinks([backendRepo], repeatedConstFront);
  // Either path should NOT land in unresolved (both are resolvable — no method params involved).
  // And the path should NOT contain '{p}' (that would be the bug).
  const allResults = [...result.links, ...result.drift, ...result.external];
  const hasBuggyPath = allResults.some(
    (e) => JSON.stringify(e).includes("{p}"),
  );
  assert.equal(hasBuggyPath, false, "resolved path must not contain '{p}' — the second ${API} ref should resolve fully, not fall back to {p}");
  // Also assert: the call is NOT in unresolved (it IS resolvable with fresh `seen` per call).
  const inUnresolved = result.unresolved.some(
    (u) => u.rawArg.includes("API"),
  );
  assert.equal(inUnresolved, false, "a repeated-const template is resolvable and must not land in unresolved");
});

test("R2-F1: from.symbol for top-level const arrow 'listOrders' is 'listOrders', not null/rawArg", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([backendRepo], constArrowFront);
  // listOrders const arrow calls this.rest.get(`${BASE}/orders`)
  // Should link to listOrders operationId from the existing backend fixture
  const link = result.links.find((l: ServiceLink) => l.contractRef === "listOrders");
  assert.ok(link, "expected a link for listOrders (const arrow)");
  assert.equal(
    link.from.symbol,
    "listOrders",
    `expected from.symbol='listOrders' from const arrow, got '${link.from.symbol}'`,
  );
});

// ---- L1.5 (renamed): string-concat path arg → external bucket, no false link ----
// 'name-x-api/' + v + '/p' — CALL_RE captures the concatenation expression.
// resolveArg sees first char is `'` → extracts quoted prefix up to first closing `'` → "name-x-api/".
// SERVICE_PREFIX_RE matches with service="x", resource="" — service "x" not in known repos → external.
// No structural match is attempted → no false link.
test("L1.5: string-concat path arg lands in external bucket (not a false link, no structural match)", async () => {
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  // Use only the orders backend — "x" is not a known service, so it goes to external.
  const result = await resolver.resolveLinks([mixedParamBackend], concatFront);
  // The key invariant: string-concat must NOT produce a false ServiceLink.
  const hasLink = result.links.some(
    (l: ServiceLink) => JSON.stringify(l.from).includes("name-x-api"),
  );
  assert.equal(hasLink, false, "string-concat path must not produce a false link (no structural match)");
  // The concat arg resolves to the partial quoted prefix "name-x-api/" → external bucket
  // (service "x" unknown), or unresolved if the regex doesn't match. Either way: no link.
  const classified = result.external.some((e) => e.path.includes("name-x-api"))
    || result.unresolved.some((u) => u.rawArg.includes("name-x-api"))
    || result.drift.some((d) => d.path.includes("name-x-api"));
  assert.ok(classified, "string-concat path should be classified in external, unresolved, or drift — not silently dropped");
});

// ==========================================
// R2-F7: Isolated fallback unit tests (extractEnclosingMethodFallback)
// ==========================================
// These tests verify the backward-scan fallback WITHOUT tree-sitter — no WASM load, no fixtures,
// pure function call. Guards against regressions in the fallback path that would otherwise only
// surface when tree-sitter is unavailable in the environment.

test("R2-F7: extractEnclosingMethodFallback returns method name before call-site", () => {
  const text = [
    "class OrdersApi {",
    "  listOrders() {",
    "    return this.rest.get('/name-orders-api/orders');",
    "  }",
    "}",
  ].join("\n");
  const callIndex = text.indexOf("this.rest.get");
  const name = extractEnclosingMethodFallback(text, callIndex);
  assert.equal(name, "listOrders", `expected 'listOrders', got '${name}'`);
});

test("R2-F7: extractEnclosingMethodFallback returns null on bare top-level code (no enclosing method)", () => {
  const text = "this.rest.get('/name-orders-api/orders');";
  const callIndex = 0;
  const name = extractEnclosingMethodFallback(text, callIndex);
  // No method declaration before the call-site → should return null, never throw.
  assert.equal(name, null, `expected null for bare top-level code, got '${name}'`);
});

test("R2-F7: extractEnclosingMethodFallback never throws on empty input", () => {
  assert.doesNotThrow(() => {
    extractEnclosingMethodFallback("", 0);
  });
});

test("R2-F7: extractEnclosingMethodFallback never throws when matchIndex exceeds text length", () => {
  assert.doesNotThrow(() => {
    extractEnclosingMethodFallback("short text", 9999);
  });
});

// ==========================================
// AGNOSTICISM PROOF (Invariant #1) — REQUIRED acceptance test
// ==========================================
// A SECOND, DIFFERENT profile — different receiver (this.http vs nname's this.rest) AND a
// different servicePrefixTemplate ("{service}-service" vs nname's "name-{service}-api") —
// resolved through the SAME OpenApiHttpResolver core. If the core still carried an nname
// literal anywhere (the receiver, the prefix shape, or the repo-slug shape), this fixture
// would resolve nothing: it deliberately shares NO string pattern with the nname fixtures.
const ALT_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.http" },
  servicePrefixTemplate: "{service}-service",
  serviceRepoTemplate: "{service}-service-repo",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};
const altBackend: RepoRef = {
  repo: "ArielFalcon/menu-service-repo",
  mirrorDir: join(FIXTURES, "backend-alt-profile"),
};
const altFront: RepoRef = {
  repo: "ArielFalcon/some-other-webapp",
  mirrorDir: join(FIXTURES, "frontend-alt-profile"),
};

test("AGNOSTICISM: a second profile (this.http, '{service}-service') resolves through the same core", async () => {
  const resolver = new OpenApiHttpResolver(ALT_PROFILE);
  const result = await resolver.resolveLinks([altBackend], altFront);
  const listLink = result.links.find((l: ServiceLink) => l.contractRef === "listMenuItems");
  assert.ok(listLink, "expected a matched ServiceLink with contractRef=listMenuItems under the alt profile");
  assert.equal(listLink.from.repo, altFront.repo);
  assert.equal(listLink.to.repo, altBackend.repo);
  assert.equal(listLink.confidence, 1);
  assert.equal(listLink.source, "openapi-http");

  const getByIdLink = result.links.find((l: ServiceLink) => l.contractRef === "getMenuItemById");
  assert.ok(getByIdLink, "expected a matched ServiceLink with contractRef=getMenuItemById under the alt profile");
});

test("AGNOSTICISM: the alt profile's receiver (this.http) does NOT leak into an nname-profile run, and vice versa", async () => {
  // Cross-check: running the NNAME_PROFILE against the alt fixtures (this.http call-sites)
  // must find nothing, because nname's frontCallSite.receiver is "this.rest" — proving the
  // receiver is genuinely read from the injected profile, not from a core default.
  const resolver = new OpenApiHttpResolver(NNAME_PROFILE);
  const result = await resolver.resolveLinks([altBackend], altFront);
  assert.equal(result.links.length, 0, "nname profile (this.rest) must not match this.http call-sites");
});

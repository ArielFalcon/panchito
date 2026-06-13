import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ExplorationBrief,
  validateExplorationBrief,
  parseExplorationBrief,
  coerceExplorationBrief,
  renderExplorationBrief,
} from "./exploration-brief";

// A minimal well-formed brief reused across tests.
function validBrief(overrides: Partial<ExplorationBrief> = {}): ExplorationBrief {
  return {
    builtForSha: "abc1234def",
    objective: "given a cart with >10 items, when paying, then the bulk discount applies",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout/checkout.service.ts", role: "applies the bulk discount and creates the order" }],
    feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
    contracts: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
    routes: [{ path: "/checkout", component: "CheckoutComponent", domLandmarks: ["Pay button", "Total label"], verified: false }],
    risks: ["the discount only shows after the cart re-queries — assert the re-queried total"],
    ...overrides,
  };
}

// ── validateExplorationBrief ────────────────────────────────────────────────

test("validateExplorationBrief accepts a well-formed brief", () => {
  assert.deepEqual(validateExplorationBrief(validBrief()), { ok: true, errors: [] });
});

test("validateExplorationBrief accepts a pure-logic brief with no routes/feBe/contracts", () => {
  const brief = validBrief({ feBe: undefined, contracts: undefined, routes: undefined, risks: undefined });
  assert.equal(validateExplorationBrief(brief).ok, true);
});

test("validateExplorationBrief accepts an empty blastRadius array (emptiness is a signal, not a form error)", () => {
  assert.equal(validateExplorationBrief(validBrief({ blastRadius: [] })).ok, true);
});

test("validateExplorationBrief rejects a non-object / null / array", () => {
  assert.equal(validateExplorationBrief(null).ok, false);
  assert.equal(validateExplorationBrief([]).ok, false);
  assert.equal(validateExplorationBrief("nope").ok, false);
});

test("validateExplorationBrief requires builtForSha (provenance / staleness signal)", () => {
  const v = validateExplorationBrief(validBrief({ builtForSha: "" }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /builtForSha/);
});

test("validateExplorationBrief requires an objective", () => {
  const v = validateExplorationBrief(validBrief({ objective: "  " }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /objective/);
});

test("validateExplorationBrief: blastRadius must be an array", () => {
  const v = validateExplorationBrief({ ...validBrief(), blastRadius: "CheckoutService.pay" } as unknown);
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /blastRadius/);
});

test("validateExplorationBrief: a blast node needs symbol, file AND role (the role is the distillate)", () => {
  const noRole = validateExplorationBrief(validBrief({ blastRadius: [{ symbol: "X.y", file: "src/x.ts", role: "" }] }));
  assert.equal(noRole.ok, false);
  assert.match(noRole.errors.join("\n"), /role/);

  const noFile = validateExplorationBrief(validBrief({ blastRadius: [{ symbol: "X.y", file: "", role: "does y" }] }));
  assert.equal(noFile.ok, false);
  assert.match(noFile.errors.join("\n"), /file/);
});

test("validateExplorationBrief: an feBe fact needs route and operationId when present", () => {
  const v = validateExplorationBrief(validBrief({ feBe: [{ route: "/checkout", operationId: "" }] }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /operationId/);
});

test("validateExplorationBrief: a contract fact needs operationId, method and path", () => {
  const v = validateExplorationBrief(validBrief({ contracts: [{ operationId: "createOrder", method: "", path: "/orders" }] }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /method/);
});

test("validateExplorationBrief: a route recon needs a path and a boolean verified", () => {
  const noPath = validateExplorationBrief(validBrief({ routes: [{ path: "", verified: false }] }));
  assert.equal(noPath.ok, false);
  assert.match(noPath.errors.join("\n"), /path/);

  const badVerified = validateExplorationBrief(validBrief({ routes: [{ path: "/x", verified: "yes" as unknown as boolean }] }));
  assert.equal(badVerified.ok, false);
  assert.match(badVerified.errors.join("\n"), /verified/);
});

// ── parseExplorationBrief ───────────────────────────────────────────────────

test("parseExplorationBrief extracts the brief from surrounding prose (last matching JSON)", () => {
  const text = `Here is what I found.\n\n{"builtForSha":"abc1234","objective":"pay flow","blastRadius":[{"symbol":"S.pay","file":"src/s.ts","role":"pays"}]}\n\nDone.`;
  const brief = parseExplorationBrief(text);
  assert.ok(brief);
  assert.equal(brief!.objective, "pay flow");
  assert.equal(brief!.blastRadius[0]!.symbol, "S.pay");
});

test("parseExplorationBrief returns null when no brief-shaped JSON is present", () => {
  assert.equal(parseExplorationBrief("no json here"), null);
  assert.equal(parseExplorationBrief(`{"objectives":[]}`), null); // a plan, not a brief
});

test("parseExplorationBrief drops malformed blast nodes but keeps the well-formed ones", () => {
  const text = `{"builtForSha":"a","objective":"o","blastRadius":[{"symbol":"Keep.me","file":"src/k.ts","role":"r"},{"file":"src/x.ts"},"garbage"]}`;
  const brief = parseExplorationBrief(text);
  assert.ok(brief);
  assert.equal(brief!.blastRadius.length, 1);
  assert.equal(brief!.blastRadius[0]!.symbol, "Keep.me");
});

test("parseExplorationBrief defaults optional sections and route.verified", () => {
  const text = `{"builtForSha":"a","objective":"o","blastRadius":[],"routes":[{"path":"/x"}]}`;
  const brief = parseExplorationBrief(text);
  assert.ok(brief);
  assert.equal(brief!.routes![0]!.verified, false); // default false until the explorer actually navigated
});

test("parseExplorationBrief output round-trips through validation", () => {
  const text = `prose ${JSON.stringify(validBrief())} more prose`;
  const brief = parseExplorationBrief(text);
  assert.ok(brief);
  assert.equal(validateExplorationBrief(brief!).ok, true);
});

// ── renderExplorationBrief ──────────────────────────────────────────────────

test("renderExplorationBrief carries the selector-fidelity guard (landmarks are hints, code/DOM wins)", () => {
  const out = renderExplorationBrief(validBrief());
  assert.match(out, /HINTS/);
  assert.match(out, /code\/DOM wins/i);
});

test("renderExplorationBrief renders blast-radius symbols with their distilled role", () => {
  const out = renderExplorationBrief(validBrief());
  assert.match(out, /CheckoutService\.pay/);
  assert.match(out, /applies the bulk discount/);
});

test("renderExplorationBrief sanitizes injected secrets before the writer sees them", () => {
  const out = renderExplorationBrief(validBrief({ risks: ["leak ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA now"] }));
  assert.doesNotMatch(out, /ghp_AAAA/, "a token in the brief must be redacted before the prompt");
});

test("renderExplorationBrief is bounded so a huge brief cannot blow the token budget", () => {
  const huge = validBrief({ risks: Array.from({ length: 2000 }, (_, i) => `risk number ${i} ${"x".repeat(100)}`) });
  const out = renderExplorationBrief(huge);
  assert.ok(out.length <= 20_200, `expected bounded output, got ${out.length} chars`);
});

// ── coerceExplorationBrief (an ALREADY-parsed object, not text) ──────────────
// Used by parsePlan, where each objective carries the brief as a nested object (not a JSON string).

test("coerceExplorationBrief coerces an already-parsed brief object", () => {
  const brief = coerceExplorationBrief({ builtForSha: "a", objective: "o", blastRadius: [{ symbol: "S.pay", file: "src/s.ts", role: "pays" }] });
  assert.ok(brief);
  assert.equal(brief!.blastRadius[0]!.symbol, "S.pay");
});

test("coerceExplorationBrief returns null without a blastRadius array (the brief signature)", () => {
  assert.equal(coerceExplorationBrief({ objective: "o" }), null);
  assert.equal(coerceExplorationBrief("nope"), null);
  assert.equal(coerceExplorationBrief(null), null);
});

test("parseExplorationBrief and coerceExplorationBrief agree on the same brief", () => {
  const obj = { builtForSha: "a", objective: "o", blastRadius: [{ symbol: "S", file: "f", role: "r" }] };
  assert.deepEqual(parseExplorationBrief(`prose ${JSON.stringify(obj)} prose`), coerceExplorationBrief(obj));
});

test("coerceExplorationBrief drops blast nodes missing a file (a node with no locator is useless)", () => {
  const brief = coerceExplorationBrief({
    builtForSha: "a",
    objective: "o",
    blastRadius: [{ symbol: "Has.file", file: "src/x.ts", role: "r" }, { symbol: "No.file", role: "r" }],
  });
  assert.ok(brief);
  assert.equal(brief!.blastRadius.length, 1);
  assert.equal(brief!.blastRadius[0]!.symbol, "Has.file");
});

test("coerceExplorationBrief drops feBe entries missing route or operationId (no garbage links)", () => {
  const brief = coerceExplorationBrief({
    builtForSha: "a",
    objective: "o",
    blastRadius: [{ symbol: "S", file: "f", role: "r" }],
    feBe: [{ route: "/x", operationId: "op" }, { route: "/y" }, { operationId: "z" }],
  });
  assert.equal(brief!.feBe!.length, 1);
  assert.equal(brief!.feBe![0]!.operationId, "op");
});

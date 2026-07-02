import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPreExecGrounding,
  type RouteTree,
} from "@contexts/qa-run-orchestration/domain/pre-exec-grounding.service.ts";

// pre-exec-grounding.service.ts (Plan 7-R B5.2) — composes the ambiguity check (B0/B5.1's
// unscopedMultipleContradictions) + the Pillar-2 catalog gate (verbatim confidentWindowEnd/
// extractTestIdSelectorsWithIndex composition, B1) with TWO fixes baked in as declared behavior:
//   - leak 6b: PER-SPEC ROUTE PAIRING — a spec is checked only against trees of routes IT targets.
//   - SAFE DIRECTION: catalog corrections feed ONLY the one-shot repair, NEVER a deterministic
//     block; degraded/unsettled routes are advisory; only a PERSISTING ambiguity may escalate.
//
// Input shape: RouteTree[] (route + nodes[] + optional catalog fields) — a domain-local, minimal
// mirror of generation/infrastructure's RouteSnapshot/RouteCatalog SHAPE (not imported — domain/
// never imports another context; the use-case adapts the real capture into this shape).

test("checkPreExecGrounding: no routes captured -> zero corrections, zero counters", () => {
  const result = checkPreExecGrounding({ specSources: [`await page.goto("/owners");`], routes: [] });
  assert.deepEqual(result.corrections, []);
  assert.equal(result.preExecAmbiguityCatches, 0);
  assert.equal(result.catalogGateInWindow, 0);
  assert.equal(result.catalogGateAdvisory, 0);
  assert.equal(result.catalogGateFailClosed, 0);
});

test("checkPreExecGrounding: a page-rooted MULTIPLE ambiguity on the spec's OWN route is caught", () => {
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners"] },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.match(result.corrections[0]!, /MULTIPLE/);
});

// ── Leak 6b: per-spec route pairing ─────────────────────────────────────────────────────────
test("leak 6b fix: spec A's ambiguity does NOT leak into spec B's route (per-spec pairing)", () => {
  // Spec A targets /list (5 "Edit" buttons -> real ambiguity). Spec B targets /detail (1 "Edit"
  // button -> no ambiguity). Cross-producting ALL specs x ALL trees (the pre-fix behavior) would
  // wrongly check spec B's selector against /list's tree too, since /list's tree also happens to
  // multiply-match "Edit" — but spec B never navigates there, so that tree is NOT its own ground
  // truth. Per-spec pairing (leak 6b) must yield ZERO contradictions for spec B.
  const specA = `await page.goto("/list"); await page.getByRole("button", { name: "Edit" }).click();`;
  const specB = `await page.goto("/detail"); await page.getByRole("button", { name: "Edit" }).click();`;
  const routes: RouteTree[] = [
    { route: "/list", nodes: Array(5).fill("button: Edit") },
    { route: "/detail", nodes: ["button: Edit"] },
  ];
  const result = checkPreExecGrounding({ specSources: [specA, specB], routes });
  // Only spec A's ambiguity should surface; spec B's own route (/detail) has a unique "Edit".
  assert.equal(result.preExecAmbiguityCatches, 1);
});

test("leak 6b fix: a spec with no first-goto route is checked against ALL captured routes (advisory fallback unaffected)", () => {
  // A spec with no literal .goto(...) (e.g. it reuses fixtures/navigation helpers) cannot be paired
  // to a specific route — the pairing degrades to the full route set rather than silently excluding
  // it from grounding entirely (never a false negative that hides a real ambiguity).
  const specSources = [`await page.getByRole("heading", { name: "Owners" }).click();`];
  const routes: RouteTree[] = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
});

// ── Catalog gate composition (Pillar 2, B1) ─────────────────────────────────────────────────
test("catalog gate: a fabricated test-id inside the confident window on a captured&&settled route yields a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["real-id", 1]]) },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.catalogGateInWindow, 1);
  assert.equal(result.catalogGateAdvisory, 0);
  assert.equal(result.corrections.length, 1);
  assert.match(result.corrections[0]!, /ghost-id/);
  assert.match(result.corrections[0]!, /NOT in the captured DOM/);
});

test("catalog gate: a test-id present in the catalog is NOT a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("real-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["real-id", 1]]) },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateInWindow, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: a DEGRADED route is advisory only — never a fail-closed correction (safe direction)", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "degraded", settled: false, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: an UNSETTLED route is advisory only — never a fail-closed correction (safe direction)", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: false, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: a selector AFTER the confident window closes (post-click) is advisory only", () => {
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("button", { name: "Add" }).click(); await page.getByTestId("late-id").click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["button: Add"], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
});

test("catalog gate corrections NEVER escalate preExecAmbiguityCatches — the two channels stay independent", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.preExecAmbiguityCatches, 0); // catalog corrections are NOT ambiguity catches
});

test("SAFE DIRECTION: corrections combine ambiguity + catalog for the one-shot repair channel", () => {
  // Both selectors sit BEFORE the first click, inside the confident window — an ambiguous
  // page-rooted role selector AND a fabricated test-id, on the SAME spec/route, must both surface
  // as corrections (they are independent sub-gates, composed, never one suppressing the other).
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click(); await page.getByTestId("ghost-id").fill("x"); await page.getByRole("button", { name: "Save" }).click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners", "button: Save"], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.equal(result.catalogGateFailClosed, 0, "the ghost-id selector sits AFTER the first click — outside the confident window, so it stays advisory (not a correction)");
  assert.equal(result.catalogGateAdvisory, 1);
  assert.equal(result.corrections.length, 1);
});

test("SAFE DIRECTION: an ambiguity correction and a catalog correction on DIFFERENT specs both surface (independent sub-gates)", () => {
  const ambiguousSpec = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
  const fabricatedIdSpec = `await page.goto("/pets"); await page.getByTestId("ghost-id").click();`;
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners"], status: "captured", settled: true, testIds: new Map() },
    { route: "/pets", nodes: [], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources: [ambiguousSpec, fabricatedIdSpec], routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.corrections.length, 2);
});

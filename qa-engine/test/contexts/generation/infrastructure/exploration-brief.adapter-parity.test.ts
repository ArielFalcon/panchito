// test/contexts/generation/infrastructure/exploration-brief.adapter-parity.test.ts
// PARITY: the wrapper round-trips a brief through both the adapter and the legacy fn,
// proving parse/coerce/render produce identical results.
// Imports from src/qa/exploration-brief.ts (NOT src/integrations/ — there is no such file).
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExplorationBriefAdapter } from "@contexts/generation/infrastructure/exploration-brief.adapter.ts";
import {
  parseExplorationBrief as legacy,
  coerceExplorationBrief as legacyCoerce,
  renderExplorationBrief as legacyRender,
} from "../../../../../src/qa/exploration-brief.ts";

const BRIEF_JSON = JSON.stringify({
  builtForSha: "abc1234dead",
  objective: "test the checkout flow",
  blastRadius: [
    { symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "processes payment" },
  ],
  risks: ["payment may fail silently"],
});

test("PARITY: parse wrapper matches legacy parseExplorationBrief on valid JSON", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: legacy,
    coerceExplorationBrief: legacyCoerce,
    renderExplorationBrief: legacyRender,
  });
  const adapterResult = adapter.parse(BRIEF_JSON);
  const legacyResult = legacy(BRIEF_JSON);
  assert.deepEqual(adapterResult, legacyResult);
});

test("PARITY: parse wrapper matches legacy on garbage input (both return null)", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: legacy,
    coerceExplorationBrief: legacyCoerce,
    renderExplorationBrief: legacyRender,
  });
  const adapterResult = adapter.parse("not json at all {{ }");
  const legacyResult = legacy("not json at all {{ }");
  assert.deepEqual(adapterResult, legacyResult);
});

test("PARITY: coerce wrapper matches legacy coerceExplorationBrief", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: legacy,
    coerceExplorationBrief: legacyCoerce,
    renderExplorationBrief: legacyRender,
  });
  const raw = {
    builtForSha: "def5678",
    objective: "login flow",
    blastRadius: [{ symbol: "AuthService.login", file: "auth.ts", role: "authenticates" }],
    feBe: [{ route: "/login", operationId: "postLogin" }],
  };
  const adapterResult = adapter.coerce(raw);
  const legacyResult = legacyCoerce(raw);
  assert.deepEqual(adapterResult, legacyResult);
});

test("PARITY: render wrapper matches legacy renderExplorationBrief", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: legacy,
    coerceExplorationBrief: legacyCoerce,
    renderExplorationBrief: legacyRender,
  });
  const brief = {
    builtForSha: "abc1234",
    objective: "test the login flow",
    blastRadius: [{ symbol: "LoginService.login", file: "src/login.ts", role: "handles auth" }],
    risks: ["session may expire"],
  };
  const adapterResult = adapter.render(brief);
  const legacyResult = legacyRender(brief);
  assert.equal(adapterResult, legacyResult);
});

test("PARITY: render suppressFeBe option matches legacy", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: legacy,
    coerceExplorationBrief: legacyCoerce,
    renderExplorationBrief: legacyRender,
  });
  const brief = {
    builtForSha: "abc1234",
    objective: "test the login flow",
    blastRadius: [{ symbol: "LoginService.login", file: "src/login.ts", role: "handles auth" }],
    feBe: [{ route: "/login", operationId: "postLogin" }],
  };
  const adapterResult = adapter.render(brief, { suppressFeBe: true });
  const legacyResult = legacyRender(brief, { suppressFeBe: true });
  assert.equal(adapterResult, legacyResult);
});

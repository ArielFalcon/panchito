// Parity test: assert the ported qa-engine buildContextPack matches the legacy src/qa/context-pack.ts
// buildContextPack byte-for-byte on representative inputs. This file imports from src/ (outside
// qa-engine rootDir) and is excluded from qa-engine typecheck (see qa-engine/tsconfig.json exclude
// list) — identical pattern to route-catalog-parity.test.ts / dom-snapshot-parity.test.ts (Plan
// 7.4a). Runs via tsx at runtime; the strangler guard keeping the port honest until Plan 7 cutover
// deletes the legacy original (Plan 7.4b).
//
// The stub deps are shaped identically for both sides (same routes/DOM content returned), so any
// text/byte-count divergence surfaces a REAL behavioral drift in the port, not a fixture mismatch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContextPack as ported, type ContextPackDeps as PortedDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { CaptureDomDeps as PortedCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { ExplorationBrief as PortedBrief, ArchitectureContext as PortedContextMap } from "@contexts/generation/application/ports/generation-ports.ts";

import { buildContextPack as legacy, type ContextPackDeps as LegacyDeps } from "../../../../../src/qa/context-pack.ts";
import type { CaptureDomDeps as LegacyCaptureDomDeps } from "../../../../../src/qa/dom-snapshot.ts";
import type { ExplorationBrief as LegacyBrief } from "../../../../../src/qa/exploration-brief.ts";
import type { ArchitectureContext as LegacyContextMap } from "../../../../../src/qa/context.ts";

const BRIEF: PortedBrief & LegacyBrief = {
  builtForSha: "abc1234",
  objective: "test the checkout flow",
  blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount and creates order" }],
  routes: [{ path: "/checkout", verified: true }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  contracts: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  risks: ["assert the discounted total"],
};

const CONTEXT_MAP: PortedContextMap & LegacyContextMap = {
  builtAtSha: "abc1234",
  routes: [{ path: "/checkout" }],
  api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
};

function portedDeps(domResult: string | undefined): PortedDeps {
  return {
    captureDomForRoutes: async (_r, _i, _d) => domResult,
    domDeps: { render: async () => [] } as PortedCaptureDomDeps,
    log: () => {},
  };
}
function legacyDeps(domResult: string | undefined): LegacyDeps {
  return {
    captureDomForRoutes: async (_r, _i, _d) => domResult,
    domDeps: { render: async () => [] } as LegacyCaptureDomDeps,
    log: () => {},
  };
}

test("PARITY: buildContextPack with only a brief (no DOM/contracts) matches legacy byte-for-byte", async () => {
  const p = await ported({ brief: BRIEF }, portedDeps(undefined));
  const l = await legacy({ brief: BRIEF }, legacyDeps(undefined));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack with brief + DOM matches legacy byte-for-byte", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const p = await ported({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, portedDeps(domContent));
  const l = await legacy({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, legacyDeps(domContent));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack with brief + contextMap (contracts) matches legacy byte-for-byte", async () => {
  const p = await ported({ brief: BRIEF, contextMap: CONTEXT_MAP }, portedDeps(undefined));
  const l = await legacy({ brief: BRIEF, contextMap: CONTEXT_MAP }, legacyDeps(undefined));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack with all components (brief + DOM + contracts) matches legacy byte-for-byte", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const p = await ported(
    { brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", contextMap: CONTEXT_MAP },
    portedDeps(domContent),
  );
  const l = await legacy(
    { brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", contextMap: CONTEXT_MAP },
    legacyDeps(domContent),
  );
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack with everything absent returns identical undefined-text result", async () => {
  const p = await ported({}, portedDeps(undefined));
  const l = await legacy({}, legacyDeps(undefined));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack large DOM (30KB budget truncation) matches legacy byte-for-byte", async () => {
  const largeLines = Array.from({ length: 2000 }, (_, i) => `button: Button ${i}`);
  const largeDom = largeLines.join("\n");
  const p = await ported({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, portedDeps(largeDom));
  const l = await legacy({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, legacyDeps(largeDom));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack unverified routes (GAP 2) matches legacy byte-for-byte", async () => {
  const brief = {
    builtForSha: "abc1234",
    objective: "test the portfolio home page",
    blastRadius: [{ symbol: "IndexPage", file: "src/pages/index.astro", role: "renders the homepage" }],
    routes: [
      { path: "/", verified: false },
      { path: "/about", verified: false },
    ],
  };
  const domContent = "heading: Hello World\nbutton: Contact me";
  const p = await ported({ brief, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, portedDeps(domContent));
  const l = await legacy({ brief, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, legacyDeps(domContent));
  assert.deepEqual(p, l);
});

test("PARITY: buildContextPack DOM capture throwing degrades identically", async () => {
  const throwingPorted: PortedDeps = {
    captureDomForRoutes: async () => { throw new Error("Playwright not available"); },
    domDeps: { render: async () => [] } as PortedCaptureDomDeps,
    log: () => {},
  };
  const throwingLegacy: LegacyDeps = {
    captureDomForRoutes: async () => { throw new Error("Playwright not available"); },
    domDeps: { render: async () => [] } as LegacyCaptureDomDeps,
    log: () => {},
  };
  const p = await ported({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, throwingPorted);
  const l = await legacy({ brief: BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" }, throwingLegacy);
  assert.deepEqual(p, l);
});

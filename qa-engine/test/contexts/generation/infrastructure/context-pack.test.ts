// Behavioral test for context-pack.ts — ported subset of src/qa/context-pack.test.ts scoped to
// `buildContextPack` ITSELF (the pure assembler this module owns). The legacy test file's remaining
// suites exercise `buildPromptAssembled`/`buildPlanPromptAssembled` from src/integrations/prompts.ts —
// a SEPARATE, not-yet-ported module (qa-engine only WRAPS it via injected fns in
// PromptRenderingAdapter/PromptBuilders; the actual string-assembly logic is out of this sub-plan's
// scope). Those "NOT INERT" / Slice-H prompt-wiring tests are intentionally NOT ported here — porting
// them would require porting prompts.ts too, which Sub-Plan 7.4b does not name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, type ContextPackInput, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { ExplorationBrief, ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";

// ── Stub factories ─────────────────────────────────────────────────────────────

function stubDomDeps(result: string | undefined): CaptureDomDeps {
  return {
    render: async () => {
      if (result === undefined) return [];
      return [{ route: "/test", nodes: result.split("\n").filter(Boolean) }];
    },
  };
}

function stubContextPackDeps(domResult: string | undefined, log?: (m: string) => void): ContextPackDeps {
  return {
    captureDomForRoutes: async (_routes, _input, _domDeps) => domResult,
    domDeps: stubDomDeps(domResult),
    log,
  };
}

const MINIMAL_BRIEF: ExplorationBrief = {
  builtForSha: "abc1234",
  objective: "test the checkout flow",
  blastRadius: [{ symbol: "CheckoutService.pay", file: "src/checkout.ts", role: "applies discount and creates order" }],
  routes: [{ path: "/checkout", verified: true }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
  contracts: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  risks: ["assert the discounted total"],
};

const MINIMAL_CONTEXT_MAP: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/checkout" }],
  api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  feBe: [{ route: "/checkout", operationId: "createOrder", via: "OrderClient.create" }],
};

// ── Unit tests for buildContextPack ───────────────────────────────────────────

test("buildContextPack returns undefined text when all components are absent", async () => {
  const result = await buildContextPack({}, stubContextPackDeps(undefined));
  assert.equal(result.text, undefined);
  assert.equal(result.blastRadiusBytes, 0);
  assert.equal(result.domBytes, 0);
  assert.equal(result.contractBytes, 0);
});

test("buildContextPack includes blast-radius section when brief is provided", async () => {
  const result = await buildContextPack({ brief: MINIMAL_BRIEF }, stubContextPackDeps(undefined));
  assert.ok(result.text !== undefined, "text should be set when brief is provided");
  assert.ok(result.text!.includes("CheckoutService.pay"), "blast-radius symbol must appear in pack text");
  assert.ok(result.text!.includes("Context Pack"), "pack header must appear");
  assert.ok(result.blastRadiusBytes > 0, "blast-radius byte count must be positive");
});

test("buildContextPack includes FeBe links from the brief", async () => {
  const result = await buildContextPack({ brief: MINIMAL_BRIEF }, stubContextPackDeps(undefined));
  assert.ok(result.text?.includes("createOrder"), "FeBe operationId must appear in pack text");
  assert.ok(result.text?.includes("/checkout"), "FeBe route must appear in pack text");
});

test("buildContextPack includes DOM section when capture succeeds", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text?.includes("Live DOM"), "DOM section header must appear");
  assert.ok(result.domBytes > 0, "DOM byte count must be positive when DOM was captured");
});

// WS5.4c — the captured DOM text is rendered by the actual DEV page and can legitimately contain a
// leaked secret-shaped string (an admin debug banner echoing a key, an attribute value that reads
// like a credential assignment). blastSection/contractSection already sanitize via the local s()
// wrapper; the DOM section was the one inconsistent gap.
test("buildContextPack sanitizes a secret-shaped string in the captured DOM text", async () => {
  const domContent = 'button: Submit\ntextbox: apiKey: "sk-liveSECRETVALUE123456"';
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(!result.text?.includes("sk-liveSECRETVALUE123456"), "a secret-shaped string in the captured DOM must not reach the pack raw");
});

test("buildContextPack omits DOM section when capture returns undefined", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text !== undefined, "text should be set from blast-radius even when DOM fails");
  assert.equal(result.domBytes, 0);
});

test("buildContextPack includes contracts from contextMap when brief references them", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, contextMap: MINIMAL_CONTEXT_MAP },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text?.includes("Relevant API contracts"), "contracts section header must appear");
  assert.ok(result.text?.includes("POST /orders"), "contract path must appear");
  assert.ok(result.contractBytes > 0, "contract byte count must be positive");
});

test("buildContextPack omits contracts when contextMap is absent", async () => {
  const result = await buildContextPack({ brief: MINIMAL_BRIEF }, stubContextPackDeps(undefined));
  assert.equal(result.contractBytes, 0);
  assert.ok(!result.text?.includes("Relevant API contracts"), "contracts section must be absent when no contextMap");
});

test("buildContextPack filters contracts using prChangedFiles", async () => {
  const result = await buildContextPack(
    {
      contextMap: MINIMAL_CONTEXT_MAP,
      prChangedFiles: ["src/app/checkout/checkout.component.ts"],
    },
    stubContextPackDeps(undefined),
  );
  assert.ok(result.text?.includes("createOrder") || result.contractBytes === 0,
    "contracts are either included (path matched) or empty (no brief to match from)");
});

// ── WS5.3: the deterministic `routes` input (option c — no LLM explorer pass) ──────────────────
// buildContextPack's candidateRoutes came ONLY from a brief (briefRoutePaths, contextMapRoutes gated
// on brief.feBe) — with no brief-less route path at all, the pack was structurally empty whenever
// the explorer pass never ran (which is EVERY production run today — the explorer stays unwired by
// design). A thin `routes` input lets a caller (the grounding adapter, deterministically, from
// contextMap.routes — no LLM) populate DOM candidates with NO brief present.
test("buildContextPack: the `routes` input populates DOM candidates with NO brief present at all", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    { routes: ["/checkout"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text?.includes("Live DOM"), "DOM section must be populated from the routes input alone, no brief needed");
  assert.ok(result.domBytes > 0, "DOM byte count must be positive from the routes-only path");
});

test("buildContextPack: `routes` input is merged with brief routes when BOTH are present (brief first, higher precision)", async () => {
  const captured: string[][] = [];
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (routes) => { captured.push(routes); return "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log: () => {},
  };
  await buildContextPack(
    { brief: MINIMAL_BRIEF, routes: ["/admin"], baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.ok(captured[0]?.includes("/checkout"), "the brief's own route must still be a candidate");
  assert.ok(captured[0]?.includes("/admin"), "the routes input's route must ALSO be a candidate");
  assert.ok(captured[0]!.indexOf("/checkout") < captured[0]!.indexOf("/admin"), "brief routes (higher precision) come first");
});

test("buildContextPack: `routes` input respects the DOM_ROUTE_CAP (6) alongside brief/contextMap routes", async () => {
  const captured: string[][] = [];
  const deps: ContextPackDeps = {
    captureDomForRoutes: async (routes) => { captured.push(routes); return "button: Submit"; },
    domDeps: stubDomDeps("button: Submit"),
    log: () => {},
  };
  const manyRoutes = Array.from({ length: 10 }, (_, i) => `/route${i}`);
  await buildContextPack(
    { routes: manyRoutes, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.equal(captured[0]?.length, 6, "the routes input must respect the same DOM_ROUTE_CAP as brief/contextMap routes");
});

test("buildContextPack: absent `routes` input is byte-identical to today (regression guard)", async () => {
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  assert.ok(result.text?.includes("Live DOM"), "unaffected behavior when routes is absent");
});

test("buildContextPack degrades gracefully when DOM capture throws", async () => {
  const deps: ContextPackDeps = {
    captureDomForRoutes: async () => { throw new Error("Playwright not available"); },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };
  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    deps,
  );
  assert.ok(result.text !== undefined, "text still set from blast-radius");
  assert.equal(result.domBytes, 0, "DOM bytes must be 0 when capture throws");
});

test("FIX 7: buildContextPack DOM section respects the FIXED 30KB budget (large DOM is truncated)", async () => {
  const largeLines = Array.from({ length: 2000 }, (_, i) => `button: Button ${i}`);
  const largeDom = largeLines.join("\n");
  const result = await buildContextPack(
    {
      brief: MINIMAL_BRIEF,
      baseUrl: "http://localhost:3000",
      e2eDir: "/fake/e2e",
    },
    stubContextPackDeps(largeDom),
  );
  assert.ok(result.domBytes > 0, "DOM section is present");
  const domSection = result.text?.split("### Live DOM")[1] ?? "";
  assert.ok(!domSection.includes("Button 1999"), "last button must be omitted (truncated by the fixed 30KB cap)");
  assert.ok(result.text?.includes("omitted"), "truncation marker must appear");
});

test("brief wired to buildContextPack produces blast-radius + DOM (unverified routes)", async () => {
  const domContent = "button: Submit\nheading: Checkout";
  const result = await buildContextPack(
    {
      brief: MINIMAL_BRIEF,
      baseUrl: "http://localhost:3000",
      e2eDir: "/fake/e2e",
    },
    stubContextPackDeps(domContent),
  );
  assert.ok(result.text !== undefined, "pack text must be set when brief is provided");
  assert.ok(result.blastRadiusBytes > 0, "blast-radius section must be non-empty when brief is wired");
  assert.ok(result.domBytes > 0, "DOM section must be captured from brief's candidate routes when wired");
  assert.ok(result.text!.includes("CheckoutService.pay"), "brief blast-radius symbol must appear in pack");
  assert.ok(result.text!.includes("Live DOM"), "DOM section header must appear in pack");
});

// ── GAP 2 (Slice H fix): DOM captured from unverified candidate routes ────────

test("GAP 2 fix: DOM captured from unverified candidate routes (verified=false)", async () => {
  const briefWithUnverifiedRoutes: ExplorationBrief = {
    builtForSha: "abc1234",
    objective: "test the portfolio home page",
    blastRadius: [{ symbol: "IndexPage", file: "src/pages/index.astro", role: "renders the homepage" }],
    routes: [
      { path: "/", verified: false },
      { path: "/about", verified: false },
    ],
  };
  const domContent = "heading: Hello World\nbutton: Contact me";
  let capturedRoutes: string[] = [];
  const capturingDeps: ContextPackDeps = {
    captureDomForRoutes: async (routes, _input, _domDeps) => {
      capturedRoutes = routes;
      return domContent;
    },
    domDeps: stubDomDeps(domContent),
    log: () => {},
  };

  const result = await buildContextPack(
    { brief: briefWithUnverifiedRoutes, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    capturingDeps,
  );

  assert.ok(capturedRoutes.length > 0, "DOM capture must be called even for unverified routes");
  assert.ok(capturedRoutes.includes("/"), "root route must be a candidate for DOM capture");
  assert.ok(result.domBytes > 0, "DOM section must be populated from unverified candidate routes");
  assert.ok(result.text?.includes("Live DOM"), "DOM section header must appear in pack");
});

test("route cap: DOM capture capped at DOM_ROUTE_CAP (6) routes", async () => {
  const manyRoutesBrief: ExplorationBrief = {
    builtForSha: "abc1234",
    objective: "test many flows",
    blastRadius: [{ symbol: "App", file: "src/App.ts", role: "root component" }],
    routes: Array.from({ length: 10 }, (_, i) => ({ path: `/route${i}`, verified: false })),
  };
  let capturedRouteCount = 0;
  const countingDeps: ContextPackDeps = {
    captureDomForRoutes: async (routes, _input, _domDeps) => {
      capturedRouteCount = routes.length;
      return routes.map((r) => `button: Button for ${r}`).join("\n");
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  await buildContextPack(
    { brief: manyRoutesBrief, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    countingDeps,
  );

  assert.ok(capturedRouteCount <= 6, `DOM capture must be capped at 6 routes, but captured ${capturedRouteCount}`);
  assert.ok(capturedRouteCount > 0, "DOM capture must have been called with at least 1 route");
});

// ── Phase 3 (Slice 1): changedElements threading to the DOM section ─────────────────────────────

test("changedElements on ContextPackInput reaches DOM section via captureDomForRoutes (4th arg)", async () => {
  const changed: ChangedElement[] = [{ file: "f.html", line: 1, testId: "register-btn", raw: "raw" }];

  let receivedChanged: ChangedElement[] | undefined = undefined;
  const trackingDeps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, _input, _domDeps, changedArg) => {
      receivedChanged = changedArg;
      return "button: Register  -> [data-testid=register-btn] [CHANGED: added data-cy=register-btn]";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  const result = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: changed },
    trackingDeps,
  );

  assert.deepEqual(receivedChanged, changed, "changedElements forwarded as 4th arg to captureDomForRoutes");
  assert.ok(result.text?.includes("[CHANGED:"), "DOM section must contain [CHANGED: marker");
});

test("changedElements=undefined on ContextPackInput → output byte-identical (regression guard)", async () => {
  const withUndefined = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e" },
    stubContextPackDeps("button: Submit"),
  );
  const withExplicitUndefined = await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", changedElements: undefined },
    stubContextPackDeps("button: Submit"),
  );
  assert.equal(withExplicitUndefined.text, withUndefined.text, "undefined changedElements is byte-identical to omitting it");
});

// ── Pillar 1: testIdAttribute threading ────────────────────────────────────────

test("testIdAttribute on ContextPackInput is forwarded to captureDomForRoutes input", async () => {
  let receivedTestIdAttribute: string | undefined = undefined;
  const trackingDeps: ContextPackDeps = {
    captureDomForRoutes: async (_routes, input, _domDeps) => {
      receivedTestIdAttribute = input.testIdAttribute;
      return "button: Submit";
    },
    domDeps: stubDomDeps(undefined),
    log: () => {},
  };

  await buildContextPack(
    { brief: MINIMAL_BRIEF, baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", testIdAttribute: "data-cy" },
    trackingDeps,
  );

  assert.equal(receivedTestIdAttribute, "data-cy", "testIdAttribute must be forwarded to captureDomForRoutes' input arg");
});

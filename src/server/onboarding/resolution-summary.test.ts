import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateResolution } from "./resolution-summary";
import type { ResolveLinksResult } from "@contexts/service-topology/application/ports/index.ts";

function ref(repo: string, file: string, symbol: string) {
  return { repo, file, symbol };
}

test("aggregateResolution groups links by (fromRepo,toRepo,transport) with counts", () => {
  const input: ResolveLinksResult = {
    links: [
      { from: ref("org/web", "a.api.ts", "getX"), to: ref("org/svc-a", "x.ts", "opX"), transport: "http", confidence: 1, source: "openapi" },
      { from: ref("org/web", "b.api.ts", "getY"), to: ref("org/svc-a", "y.ts", "opY"), transport: "http", confidence: 1, source: "openapi" },
      { from: ref("org/web", "c.api.ts", "getZ"), to: ref("org/svc-b", "z.ts", "opZ"), transport: "http", confidence: 1, source: "openapi" },
    ],
    drift: [],
    external: [{ path: "/ext", verb: "GET" }],
    unresolved: [{ rawArg: "`/weird/${id}`", file: "d.api.ts" }, { rawArg: "x", file: "e.api.ts" }],
  };

  const summary = aggregateResolution(input);

  assert.deepEqual(summary.edges, [
    { fromRepo: "org/web", toRepo: "org/svc-a", transport: "http", calls: 2 },
    { fromRepo: "org/web", toRepo: "org/svc-b", transport: "http", calls: 1 },
  ]);
  assert.equal(summary.unresolved, 2);
  assert.equal(summary.external, 1);
});

test("aggregateResolution on an empty result is all-zero", () => {
  const summary = aggregateResolution({ links: [], drift: [], external: [], unresolved: [] });
  assert.deepEqual(summary, { edges: [], unresolved: 0, external: 0 });
});

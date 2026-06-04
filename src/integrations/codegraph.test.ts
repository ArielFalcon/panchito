import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCodegraph } from "./codegraph";
import { McpClient } from "./mcp/client";

function client(result: unknown): McpClient {
  return { callTool: async () => result };
}

test("getImpactRadius devuelve el resultado del MCP", async () => {
  const cg = makeCodegraph(client("funcs: login(), auth()"));
  assert.equal(await cg.getImpactRadius("org/app", "diff"), "funcs: login(), auth()");
});

test("getImpactRadius serializa resultados no-string", async () => {
  const cg = makeCodegraph(client({ nodes: ["a"] }));
  assert.equal(await cg.getImpactRadius("org/app", "diff"), '{"nodes":["a"]}');
});

test("getImpactRadius devuelve null si el MCP no aporta nada", async () => {
  const cg = makeCodegraph(client(""));
  assert.equal(await cg.getImpactRadius("org/app", "diff"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, extractToolResult, McpTransport, JsonRpcResponse } from "./client";

function transport(handler: (method: string, params: unknown) => JsonRpcResponse): McpTransport {
  return { send: async (req) => handler(req.method, req.params) };
}

test("callTool envía tools/call y devuelve el texto del content", async () => {
  let seen: { method: string; params: unknown } | null = null;
  const client = createMcpClient(
    transport((method, params) => {
      seen = { method, params };
      return {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "impacto: A,B" }] },
      };
    }),
  );
  const res = await client.callTool("get_impact_radius", { repo: "org/app", diff: "d" });
  assert.equal(res, "impacto: A,B");
  assert.equal(seen!.method, "tools/call");
  assert.deepEqual(seen!.params, {
    name: "get_impact_radius",
    arguments: { repo: "org/app", diff: "d" },
  });
});

test("callTool lanza si el servidor devuelve error", async () => {
  const client = createMcpClient(
    transport(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } })),
  );
  await assert.rejects(() => client.callTool("x", {}), /boom/);
});

test("extractToolResult pasa por valores que no son content", () => {
  assert.equal(extractToolResult("crudo"), "crudo");
  assert.deepEqual(extractToolResult({ foo: 1 }), { foo: 1 });
});

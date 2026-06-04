import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngram } from "./engram";
import { McpClient } from "./mcp/client";

test("getContext consulta mem_search con namespace por repo", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return "decisión previa: usar token X";
    },
  };
  const eng = makeEngram(client);
  const ctx = await eng.getContext("org/app");
  assert.equal(ctx, "decisión previa: usar token X");
  assert.equal(calls[0]!.name, "mem_search");
  assert.equal(calls[0]!.args.namespace, "repo/org/app");
});

test("save escribe con mem_save y namespace por repo", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return null;
    },
  };
  const eng = makeEngram(client);
  await eng.save({ repo: "org/app", what: "QA run" });
  assert.equal(calls[0]!.name, "mem_save");
  assert.equal(calls[0]!.args.namespace, "repo/org/app");
  assert.equal(calls[0]!.args.what, "QA run");
});

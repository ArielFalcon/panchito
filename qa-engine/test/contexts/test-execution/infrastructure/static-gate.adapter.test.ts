// test/contexts/test-execution/infrastructure/static-gate.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";

const ok = { ok: true, output: "" };
test("each method delegates to its injected check and returns its CheckResult", async () => {
  const calls: string[] = [];
  const adapter = new StaticGateAdapter({
    typecheck: async (d) => { calls.push(`tc:${d}`); return ok; },
    lint: async (d) => { calls.push(`lint:${d}`); return ok; },
    listTests: async (d) => { calls.push(`list:${d}`); return ok; },
    checkManifest: async (d) => { calls.push(`mf:${d}`); return ok; },
  });
  await adapter.typecheck("/m");
  await adapter.lint("/m");
  await adapter.listTests("/m");
  await adapter.checkManifest("/m");
  assert.deepEqual(calls, ["tc:/m", "lint:/m", "list:/m", "mf:/m"]);
});

test("a failing typecheck surfaces ok:false with the output", async () => {
  const adapter = new StaticGateAdapter({
    typecheck: async () => ({ ok: false, output: "TS2345" }),
    lint: async () => ok, listTests: async () => ok, checkManifest: async () => ok,
  });
  const r = await adapter.typecheck("/m");
  assert.equal(r.ok, false);
  assert.match(r.output, /TS2345/);
});

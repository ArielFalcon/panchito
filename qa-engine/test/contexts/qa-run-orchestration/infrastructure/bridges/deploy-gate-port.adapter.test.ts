// test/contexts/qa-run-orchestration/infrastructure/bridges/deploy-gate-port.adapter.test.ts
// RED-first (Task E.0): DeployGatePortAdapter — a REAL minimal HTTP gate over the /version poll (no
// sibling adapter exists to wrap; this bridge IS the real implementation). Injects the HTTP fetch
// primitive (same DI pattern as every other adapter here) so the test needs no real network.
// NullDeployGateAdapter always resolves ready immediately — for no-versionUrl/static/code targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployGatePortAdapter, NullDeployGateAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/deploy-gate-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import { isOk, isErr } from "@kernel/result.ts";

test("waitUntilServing() resolves ok(true) once the injected poll reports the sha is serving", async () => {
  let calls = 0;
  const poll = async (): Promise<{ serving: boolean }> => {
    calls++;
    return { serving: calls >= 2 }; // not-yet on the first poll, serving on the second
  };
  const adapter = new DeployGatePortAdapter(poll, { versionUrl: "https://dev.example.com/version", intervalMs: 0, timeoutMs: 5000 });

  const result = await adapter.waitUntilServing(Sha.of("abc1234"));

  assert.ok(isOk(result));
  assert.ok(calls >= 2, "must poll until serving, not just once");
});

test("waitUntilServing() resolves an InfraError when the timeout elapses before DEV serves the sha", async () => {
  const poll = async (): Promise<{ serving: boolean }> => ({ serving: false });
  const adapter = new DeployGatePortAdapter(poll, { versionUrl: "https://dev.example.com/version", intervalMs: 0, timeoutMs: 20 });

  const result = await adapter.waitUntilServing(Sha.of("abc1234"));

  assert.ok(isErr(result));
});

test("NullDeployGateAdapter.waitUntilServing() resolves ok(true) IMMEDIATELY — no versionUrl / static / code target", async () => {
  const adapter = new NullDeployGateAdapter();

  const result = await adapter.waitUntilServing(Sha.of("abc1234"));

  assert.ok(isOk(result));
});

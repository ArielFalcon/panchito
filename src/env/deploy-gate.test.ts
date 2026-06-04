import { test } from "node:test";
import assert from "node:assert/strict";
import {
  waitForDeploy,
  DeployTimeoutError,
  DeployTarget,
  GateDeps,
  VersionInfo,
} from "./deploy-gate";

const target: DeployTarget = {
  name: "demo",
  versionUrl: "http://dev/version",
  pollIntervalMs: 10,
  deployTimeoutMs: 1000,
};

// Reloj controlado: cada llamada a now() avanza una cantidad fija.
function clock(stepMs: number) {
  let t = 0;
  return () => {
    const cur = t;
    t += stepMs;
    return cur;
  };
}

test("resuelve cuando DEV alcanza el SHA y está healthy", async () => {
  const responses: (VersionInfo | null)[] = [
    null, // aún no responde
    { sha: "abc123", healthy: false }, // desplegando
    { sha: "abc123", healthy: true }, // listo
  ];
  let i = 0;
  const deps: GateDeps = {
    fetchVersion: async () => responses[i++] ?? null,
    sleep: async () => {},
    now: clock(50),
  };
  await assert.doesNotReject(waitForDeploy(target, "abc123", deps));
  assert.equal(i, 3); // consultó hasta encontrar el match
});

test("lanza DeployTimeoutError si nunca alcanza el SHA", async () => {
  const deps: GateDeps = {
    fetchVersion: async () => ({ sha: "viejo", healthy: true }),
    sleep: async () => {},
    now: clock(300), // supera deployTimeoutMs=1000 en pocas vueltas
  };
  await assert.rejects(() => waitForDeploy(target, "nuevo", deps), DeployTimeoutError);
});

test("no acepta el SHA correcto si no está healthy", async () => {
  const deps: GateDeps = {
    fetchVersion: async () => ({ sha: "abc123", healthy: false }),
    sleep: async () => {},
    now: clock(300),
  };
  await assert.rejects(() => waitForDeploy(target, "abc123", deps), DeployTimeoutError);
});

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

// Controlled clock: each now() call advances by a fixed amount.
function clock(stepMs: number) {
  let t = 0;
  return () => {
    const cur = t;
    t += stepMs;
    return cur;
  };
}

test("resolves when DEV reaches the SHA and is healthy", async () => {
  const responses: (VersionInfo | null)[] = [
    null, // not responding yet
    { sha: "abc123", healthy: false }, // deploying
    { sha: "abc123", healthy: true }, // ready
  ];
  let i = 0;
  const deps: GateDeps = {
    fetchVersion: async () => responses[i++] ?? null,
    sleep: async () => {},
    now: clock(50),
  };
  await assert.doesNotReject(waitForDeploy(target, "abc123", deps));
  assert.equal(i, 3); // polled until it found the match
});

test("throws DeployTimeoutError if it never reaches the SHA", async () => {
  const deps: GateDeps = {
    fetchVersion: async () => ({ sha: "old", healthy: true }),
    sleep: async () => {},
    now: clock(300), // exceeds deployTimeoutMs=1000 in a few iterations
  };
  await assert.rejects(() => waitForDeploy(target, "new", deps), DeployTimeoutError);
});

test("does not accept the right SHA if it is not healthy", async () => {
  const deps: GateDeps = {
    fetchVersion: async () => ({ sha: "abc123", healthy: false }),
    sleep: async () => {},
    now: clock(300),
  };
  await assert.rejects(() => waitForDeploy(target, "abc123", deps), DeployTimeoutError);
});

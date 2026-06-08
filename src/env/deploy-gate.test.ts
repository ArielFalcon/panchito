import { test } from "node:test";
import assert from "node:assert/strict";
import {
  waitForDeploy,
  shaMatches,
  DeployTimeoutError,
  DeployTarget,
  GateDeps,
  VersionInfo,
} from "./deploy-gate";

const FULL = "abc1234def5678abc1234def5678abc1234def56"; // 40-char SHA
const SHORT = "abc1234"; // the 7-char short form many /version endpoints emit

test("shaMatches: equal, and short-vs-full prefix either way (case-insensitive)", () => {
  assert.equal(shaMatches(FULL, FULL), true);
  assert.equal(shaMatches(SHORT, FULL), true); // /version short vs full trigger
  assert.equal(shaMatches(FULL, SHORT), true); // full /version vs short trigger
  assert.equal(shaMatches(FULL.toUpperCase(), SHORT), true);
});

test("shaMatches: different SHAs and too-short prefixes never match", () => {
  assert.equal(shaMatches("def5678abc", FULL), false); // different
  assert.equal(shaMatches("abc", FULL), false); // 3-char prefix is below the 7-char floor
  assert.equal(shaMatches("", FULL), false);
  assert.equal(shaMatches(undefined, FULL), false);
});

test("resolves when DEV reports a SHORT SHA against a full target SHA", async () => {
  const deps: GateDeps = {
    fetchVersion: async () => ({ sha: SHORT, healthy: true }),
    sleep: async () => {},
    now: clock(50),
  };
  await assert.doesNotReject(waitForDeploy(target, FULL, deps));
});

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

// qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubEnv } from "../../../src/shared-infrastructure/process-sandbox/scrub-env.ts";
// NOTE: 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/

// Safe env restore: `process.env = orig` assigns Record<string,string|undefined> to NodeJS.ProcessEnv
// and fails strict typecheck. Use per-key save/restore instead: delete keys added during the test,
// then Object.assign to restore modified values.

test("scrubEnv drops secrets even if extraAllowed would match", () => {
  const added = ["GITHUB_TOKEN", "DOPPLER_TOKEN"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) { saved[k] = process.env[k]; process.env[k] = k === "GITHUB_TOKEN" ? "ghp_secret" : "dp_secret"; }
  try {
    const out = scrubEnv({ extraAllowed: /^GITHUB_/ }); // even though caller widens to GITHUB_*, secrets stay blocked
    assert.equal("GITHUB_TOKEN" in out, false);
    assert.equal("DOPPLER_TOKEN" in out, false);
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv keeps OS + language essentials and forwards PLAYWRIGHT_BROWSERS_PATH", () => {
  const added = ["PATH", "PLAYWRIGHT_BROWSERS_PATH"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) saved[k] = process.env[k];
  try {
    process.env.PATH = "/usr/bin";
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
    const out = scrubEnv();
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv honors an extra allow prefix for non-secret vars (e2e DEV_*)", () => {
  const key = "DEV_LOGIN_USER";
  const savedVal = process.env[key];
  try {
    process.env[key] = "alice";
    assert.equal(scrubEnv({ extraAllowed: /^DEV_/ })[key], "alice");
    assert.equal(key in scrubEnv(), false); // dropped without the widening
  } finally {
    if (savedVal === undefined) delete process.env[key]; else process.env[key] = savedVal;
  }
});

// migration-tier-4b Slice 1 (gate DEFECT-2 fix): CBM_CACHE_DIR is NOT in the narrow base allowlist
// any more — it must be requested explicitly via extraExact, per-consumer. A bare scrubEnv() call
// (what every migrated code-execution/validate consumer uses) must NOT see it; only a caller that
// opts in (codebase-memory-client.ts, for its own spawn) gets it. See codebase-memory-client.test.ts
// for the regression pin proving that ONE real consumer still receives it after the migration.
test("CBM_CACHE_DIR is dropped by the narrow base — a bare scrubEnv() call does not widen for it", () => {
  process.env.CBM_CACHE_DIR = "/app/.codebase-memory";
  try {
    const env = scrubEnv();
    assert.equal("CBM_CACHE_DIR" in env, false, "the narrow base must not carry CBM_CACHE_DIR");
  } finally {
    delete process.env.CBM_CACHE_DIR;
  }
});

test("CBM_CACHE_DIR survives the scrub ONLY when a caller opts in via extraExact (cache path, not a secret)", () => {
  process.env.CBM_CACHE_DIR = "/app/.codebase-memory";
  try {
    const env = scrubEnv({ extraExact: new Set(["CBM_CACHE_DIR"]) });
    assert.equal(env.CBM_CACHE_DIR, "/app/.codebase-memory");
  } finally {
    delete process.env.CBM_CACHE_DIR;
  }
});

// Ported from src/qa/code-runner.test.ts (migration-tier-4b, Slice 1 — code-execution migration):
// the allowlist must keep whole FAMILIES of package-manager/locale vars (npm_config_*, CARGO_*,
// LC_*, GRADLE_*), not just the bare prefix string — otherwise `npm ci` loses its registry/cache/
// proxy config and Cargo/Gradle lose their home dirs. This test did not previously exist in this
// file (the pre-migration qa-engine twin lacked it); ported here to close the gap, not duplicate it.
test("scrubEnv preserves prefix-family language vars (npm_config_*, CARGO_*, LC_*, GRADLE_*) while still blocking secret families", () => {
  const added = ["npm_config_cache", "npm_config_registry", "CARGO_HOME", "LC_ALL", "GRADLE_USER_HOME", "DOPPLER_TOKEN"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) saved[k] = process.env[k];
  try {
    process.env.npm_config_cache = "/cache";
    process.env.npm_config_registry = "https://registry.local";
    process.env.CARGO_HOME = "/home/u/.cargo";
    process.env.LC_ALL = "C.UTF-8";
    process.env.GRADLE_USER_HOME = "/home/u/.gradle";
    process.env.DOPPLER_TOKEN = "dp_fakeSecret"; // a secret family → must STILL be dropped
    const env = scrubEnv();
    assert.equal(env.npm_config_cache, "/cache", "npm_config_* must be preserved (npm ci needs it)");
    assert.equal(env.npm_config_registry, "https://registry.local");
    assert.equal(env.CARGO_HOME, "/home/u/.cargo");
    assert.equal(env.LC_ALL, "C.UTF-8");
    assert.equal(env.GRADLE_USER_HOME, "/home/u/.gradle");
    assert.ok(!("DOPPLER_TOKEN" in env), "DOPPLER_ secrets must still be blocked");
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

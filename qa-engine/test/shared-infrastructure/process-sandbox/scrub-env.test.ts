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
    const out = scrubEnv(/^GITHUB_/); // even though caller widens to GITHUB_*, secrets stay blocked
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
    assert.equal(scrubEnv(/^DEV_/)[key], "alice");
    assert.equal(key in scrubEnv(), false); // dropped without the widening
  } finally {
    if (savedVal === undefined) delete process.env[key]; else process.env[key] = savedVal;
  }
});

// onboarding-auto-index (Slice 2): the codebase-memory CLI reads its graph-store location from
// CBM_CACHE_DIR. The docker volume mounts at that path — if the scrub drops the var, the CLI
// silently falls back to an unmounted container-FS default and persistence is dead on arrival.
test("CBM_CACHE_DIR survives the scrub (cache path, not a secret — the graph volume depends on it)", () => {
  process.env.CBM_CACHE_DIR = "/app/.codebase-memory";
  try {
    const env = scrubEnv();
    assert.equal(env.CBM_CACHE_DIR, "/app/.codebase-memory");
  } finally {
    delete process.env.CBM_CACHE_DIR;
  }
});

// qa-engine/test/shared-infrastructure/process-sandbox/sandbox.test.ts
// Behavioral tests for the privilege-drop sandbox primitives (§21), moved from
// src/qa/code-runner.test.ts (migration-tier-4b, Slice 1 — code-execution migration). Byte-identical
// assertions to the legacy file; only the import path changes (resolveSandbox already took `env`
// explicitly in every call here, so the removed `process.env` default does not affect these tests).
import { test } from "node:test";
import assert from "node:assert/strict";
// 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/
// (same convention as this directory's own scrub-env.test.ts).
import { resolveSandbox, sandboxSpawnOptions } from "../../../src/shared-infrastructure/process-sandbox/sandbox.ts";

// §21 sandbox identity resolver — privilege-drop applies ONLY in the root-on-Linux container with
// the baked-in user; everywhere else it must degrade to "no sandbox" so local runs are unaffected.
test("resolveSandbox applies only as root on Linux with an existing home; degrades safely otherwise", () => {
  const homeOk = () => true;
  const asRoot = () => 0;
  const base = { CODE_SANDBOX_UID: "1001" } as NodeJS.ProcessEnv;

  // The shipping case: root + linux + home present → the sandbox identity.
  assert.deepEqual(resolveSandbox(base, "linux", asRoot, homeOk), { uid: 1001, gid: 1001, home: "/home/sandbox" });

  // Every disqualifier → null (run as the current user, unchanged behavior).
  assert.equal(resolveSandbox(base, "darwin", asRoot, homeOk), null); // macOS local dev
  assert.equal(resolveSandbox(base, "linux", () => 1000, homeOk), null); // not root
  assert.equal(resolveSandbox({ CODE_SANDBOX: "off" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk), null); // escape hatch
  assert.equal(resolveSandbox(base, "linux", asRoot, () => false), null); // image lacks the user/home
  assert.equal(resolveSandbox({ CODE_SANDBOX_UID: "0" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk), null); // refuse uid 0

  // Configurable uid/gid/home.
  assert.deepEqual(
    resolveSandbox({ CODE_SANDBOX_UID: "2000", CODE_SANDBOX_GID: "2001", CODE_SANDBOX_HOME: "/sb" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk),
    { uid: 2000, gid: 2001, home: "/sb" },
  );
});

test("sandboxSpawnOptions: passthrough env when no sandbox; uid/gid + redirected HOME when sandboxed", () => {
  const env = { PATH: "/usr/bin", HOME: "/root" };
  assert.deepEqual(sandboxSpawnOptions(env, null), { env }); // unchanged, runs as current user

  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  assert.equal(opts.uid, 1001);
  assert.equal(opts.gid, 1001);
  assert.equal(opts.env.HOME, "/home/sandbox"); // toolchain caches stay out of root's home
  assert.equal(opts.env.USER, "sandbox");
  assert.equal(opts.env.PATH, "/usr/bin"); // base preserved
});

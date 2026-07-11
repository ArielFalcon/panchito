// qa-engine/test/contexts/test-execution/infrastructure/code-setup.test.ts
// Behavioral tests for the code-mode install step, moved from src/qa/code-runner.test.ts
// (migration-tier-4b, Slice 1 — code-execution migration). Byte-identical assertions to the legacy
// file; only the import path changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCodeProject, type CodeSetupDeps } from "@contexts/test-execution/infrastructure/code-setup.ts";
import type { CodeProject } from "@contexts/test-execution/infrastructure/code-execution.runner.ts";

// A hung `npm ci`/`mvn`/`gradle` install must NOT block the sequential queue forever.
// The install path needs the same timeout the test path has.
test("code-mode install that hangs is killed by timeout (does not block the queue)", { timeout: 3000 }, async () => {
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: () => new Promise(() => {}) }; // never resolves
  await assert.rejects(() => setupCodeProject("/r", deps, { timeoutMs: 100 }), /timeout/i);
});

test("setupCodeProject runs install only when there is an install command", async () => {
  let installed = 0;
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: async () => { installed++; } };
  await setupCodeProject("/r", deps);
  assert.equal(installed, 1);

  const noInstall: CodeSetupDeps = {
    detect: () => ({ ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } }),
    install: async () => { installed++; },
  };
  await setupCodeProject("/r", noInstall);
  assert.equal(installed, 1); // unchanged
});

test("setupCodeProject prepares the sandbox workdir even for a null-install ecosystem (before the early return)", async () => {
  // §21: Maven/Gradle/Rust have no install step, but their FIRST untrusted spawn is the test —
  // so the chown-to-sandbox must still run for them. prepareWorkdir must fire before install-null returns.
  const prepared: string[] = [];
  const deps: CodeSetupDeps = {
    detect: () => ({ ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } }),
    install: async () => { throw new Error("install must not run for a null-install project"); },
    prepareWorkdir: (repoDir) => prepared.push(repoDir),
  };
  await setupCodeProject("/work/repo", deps);
  assert.deepEqual(prepared, ["/work/repo"]);
});

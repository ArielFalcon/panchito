import { test } from "node:test";
import assert from "node:assert/strict";
import { setupE2eProject, SetupDeps, SetupOptions } from "./setup";

test("repo with an e2e project: installs, does not bootstrap", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => seq.push("bootstrap"),
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["install"]);
});

test("repo without an e2e project: seeds first, then installs", async () => {
  const seq: string[] = [];
  let seeded = "";
  const deps: SetupDeps = {
    hasProject: () => false,
    bootstrap: (d) => {
      seeded = d;
      seq.push("bootstrap");
    },
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["bootstrap", "install"]); // bootstrap BEFORE install
  assert.equal(seeded, "/mirror/e2e");
});

// ── Process safeguards: install timeout + operator cancel ────────────────────

test("a hung install times out and throws (the pipeline surfaces it as infra-error)", async () => {
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: () => new Promise(() => { /* hangs forever, like a wedged npm ci */ }),
  };
  await assert.rejects(
    () => setupE2eProject("/mirror/e2e", deps, { timeoutMs: 30 }),
    /timed out after 30ms — killed/,
  );
});

test("an already-aborted signal throws without starting the install", async () => {
  const controller = new AbortController();
  controller.abort();
  let installed = false;
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async () => { installed = true; },
  };
  await assert.rejects(
    () => setupE2eProject("/mirror/e2e", deps, { signal: controller.signal }),
    /aborted by operator cancel/,
  );
  assert.equal(installed, false);
});

test("signal and timeoutMs are passed through to the install deps", async () => {
  const controller = new AbortController();
  let seen: SetupOptions | undefined;
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async (_dir, opts) => { seen = opts; },
  };
  await setupE2eProject("/mirror/e2e", deps, { signal: controller.signal, timeoutMs: 5_000 });
  assert.equal(seen?.signal, controller.signal);
  assert.equal(seen?.timeoutMs, 5_000);
});

test("a failing install still propagates its own error (not a timeout)", async () => {
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
  };
  await assert.rejects(() => setupE2eProject("/mirror/e2e", deps, { timeoutMs: 5_000 }), /failed \(code 1\)/);
});

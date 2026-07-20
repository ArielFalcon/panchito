// test/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.test.ts
// migration-tier-4a: parity port of the provisioning-ARGV subset of src/integrations/
// repo-mirror.test.ts's ensureMirror/ensureMirrorAtBranch tests. Credential/auth-header decoration
// (authHeaderArgs' -c insteadOf rewrite) is NOT exercised here — that decoration now lives in the
// injector (src/integrations/repo-mirror.ts's thin wrapper, pinned by its OWN unchanged tests); this
// adapter's own argv is bare by construction, so these fakes never see a credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorProvisionAdapter, type MirrorProvisionDeps } from "@contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts";

// exists: a boolean covers both the mirror dir and the stale-lock probe; a function lets a test
// answer differently per path (e.g. "dir exists but no index.lock").
function recorder(exists: boolean | ((path: string) => boolean)): MirrorProvisionDeps & { calls: string[][]; removed: string[] } {
  const calls: string[][] = [];
  const removed: string[] = [];
  return {
    calls,
    removed,
    root: "/tmp/mirrors",
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    exists: typeof exists === "function" ? exists : () => exists,
    removeFile: (path) => {
      removed.push(path);
    },
    git: async (args) => {
      calls.push(args);
      return "ok";
    },
  };
}

test("clones, force-checks out and cleans when the working copy does not exist", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.equal(dir, "/tmp/mirrors/org__app");
  assert.deepEqual(d.calls[0], ["clone", "https://github.com/org/app.git", "/tmp/mirrors/org__app"]);
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("existing mirror: resets origin URL, fetches, force-checks out and cleans", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.calls[0], ["remote", "set-url", "origin", "https://github.com/org/app.git"]);
  assert.deepEqual(d.calls[1], ["fetch", "origin"]);
  assert.deepEqual(d.calls[2], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[3], ["clean", "-fd", "-e", "node_modules"]);
});

// ── Stale git lock self-heal ──────────────────────────────────────────────────
// The queue is strictly sequential and only the orchestrator performs git writes, so an index.lock
// present at the start of a run is stale by definition.

test("removes a stale .git/index.lock before any git command", async () => {
  const d = recorder(true); // mirror dir AND lock exist
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("ensureMirrorAtBranch also removes a stale index.lock", async () => {
  const d = recorder(true);
  await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main");
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("does not touch index.lock when absent", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, []);
});

test("does not probe for a lock on the clone path (no mirror, no lock)", async () => {
  const d = recorder(false);
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, []);
});

test("rejects a non-hex sha before spawning git (injection defense)", async () => {
  const d = recorder(true);
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "--output=/etc/passwd"), /invalid commit sha/);
  assert.equal(d.calls.length, 0); // never reached git
});

test("ensureMirror flattens a nested repo path (replaceAll, not just first slash)", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirror("org/sub/app", "abc1234");
  assert.equal(dir, "/tmp/mirrors/org__sub__app");
});

test("ensureMirrorAtBranch clones when missing and checks out origin/<branch>", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/shop-front", "main");
  assert.equal(dir, "/tmp/mirrors/org__shop-front");
  assert.equal(d.calls[0]?.[0], "clone");
  assert.ok(d.calls.some((c) => c[0] === "checkout" && c.includes("origin/main")));
  assert.ok(d.calls.some((c) => c[0] === "clean"));
});

test("ensureMirrorAtBranch fetches when the mirror exists", async () => {
  const d = recorder(true);
  await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/shop-front", "main");
  assert.ok(d.calls.some((c) => c.includes("fetch")));
  assert.ok(!d.calls.some((c) => c[0] === "clone"));
});

test("ensureMirrorAtBranch rejects a branch name that could be parsed as a git option", async () => {
  const d = recorder(true);
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/x", "--upload-pack=evil"));
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/x", "a..b"));
});

// ── Integration tests: Git boundary failure modes ────────────────────────────

test("ensureMirror propagates git clone failure (network timeout / auth failure)", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => false,
    removeFile: () => {},
    git: async () => {
      throw new Error("git clone failed: connection timeout");
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git clone failed/);
});

test("ensureMirror propagates git checkout failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed: unknown revision");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git checkout failed/);
});

test("ensureMirror propagates git fetch failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args.includes("fetch")) throw new Error("git fetch failed: 401 Unauthorized");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git fetch failed/);
});

test("ensureMirrorAtBranch propagates git clone failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => false,
    removeFile: () => {},
    git: async () => {
      throw new Error("git clone failed");
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main"), /git clone failed/);
});

test("ensureMirrorAtBranch propagates git checkout failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main"), /git checkout failed/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMirror, getCommitDiff, MirrorDeps } from "./repo-mirror";

// authHeaderArgs() depends on GITHUB_TOKEN; clear it to isolate the logic.
delete process.env.GITHUB_TOKEN;

function recorder(exists: boolean): MirrorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    root: "/tmp/mirrors",
    exists: () => exists,
    git: async (args) => {
      calls.push(args);
      return "diff-output";
    },
  };
}

test("clones, force-checks out and cleans when the working copy does not exist", async () => {
  const d = recorder(false);
  const dir = await ensureMirror("org/app", "abc1234", d);
  assert.equal(dir, "/tmp/mirrors/org__app");
  assert.equal(d.calls[0]![0], "clone");
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("fetches, force-checks out and cleans when the working copy already exists", async () => {
  const d = recorder(true);
  await ensureMirror("org/app", "abc1234", d);
  assert.deepEqual(d.calls[0], ["fetch", "origin"]);
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("getCommitDiff uses git show of the SHA", async () => {
  const d = recorder(true);
  const diff = await getCommitDiff("/tmp/mirrors/org__app", "abc1234", d);
  assert.equal(diff, "diff-output");
  assert.deepEqual(d.calls[0], ["show", "--format=", "abc1234"]);
});

test("rejects a non-hex sha (git argument-injection defense) before spawning git", async () => {
  const d = recorder(true);
  await assert.rejects(() => ensureMirror("org/app", "--output=/etc/passwd", d), /invalid commit sha/);
  await assert.rejects(() => getCommitDiff("/dir", "not-a-sha", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0); // never reached git
});

test("ensureMirror flattens a nested repo path (replaceAll, not just first slash)", async () => {
  const d = recorder(false);
  const dir = await ensureMirror("org/sub/app", "abc1234", d);
  assert.equal(dir, "/tmp/mirrors/org__sub__app");
});

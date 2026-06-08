import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMirror, getCommitDiff, listChangedSpecs, getCommitsBehind, MirrorDeps } from "./repo-mirror";

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

// A custom git stub whose output depends on the args (so the parent-count probe and
// the diff can return different things).
function gitStub(reply: (args: string[]) => string): MirrorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, root: "/tmp/mirrors", exists: () => true, git: async (args) => { calls.push(args); return reply(args); } };
}

test("getCommitDiff of a single-parent commit uses plain git show", async () => {
  // recorder's git returns "diff-output" for the %P probe → one token → single parent.
  const d = recorder(true);
  const diff = await getCommitDiff("/tmp/mirrors/org__app", "abc1234", d);
  assert.equal(diff, "diff-output");
  assert.deepEqual(d.calls[0], ["show", "-s", "--format=%P", "abc1234"]); // parent-count probe
  assert.deepEqual(d.calls[1], ["show", "--format=", "abc1234"]); // single parent → plain diff
});

test("getCommitDiff diffs a MERGE commit against its first parent (not an empty diff)", async () => {
  const d = gitStub((args) => (args.includes("--format=%P") ? "p1aaaa p2bbbb" : "real-merge-diff"));
  const diff = await getCommitDiff("/dir", "abc1234", d);
  assert.equal(diff, "real-merge-diff"); // not "" — the merge's blast radius is visible
  assert.deepEqual(d.calls[0], ["show", "-s", "--format=%P", "abc1234"]);
  assert.deepEqual(d.calls[1], ["show", "--format=", "-m", "--first-parent", "abc1234"]);
});

test("listChangedSpecs returns e2e-relative spec paths from git status, excluding the seed", async () => {
  const porcelain =
    [
      "?? e2e/flows/login.spec.ts", // new spec
      " M e2e/flows/checkout.spec.ts", // modified spec
      "?? e2e/cleanup.spec.ts", // seed — excluded
      "?? e2e/.qa/manifest.json", // not a spec — excluded
      "A  e2e/fixtures.ts", // not a spec — excluded
    ].join("\n") + "\n";
  const d = gitStub(() => porcelain);
  const specs = await listChangedSpecs("/dir", "e2e", d);
  assert.deepEqual(specs, ["flows/login.spec.ts", "flows/checkout.spec.ts"]);
});

test("listChangedSpecs follows a rename to the new path", async () => {
  const d = gitStub(() => "R  e2e/flows/old.spec.ts -> e2e/flows/new.spec.ts\n");
  assert.deepEqual(await listChangedSpecs("/dir", "e2e", d), ["flows/new.spec.ts"]);
});

test("getCommitsBehind rejects a non-hex sha before spawning git (injection defense)", async () => {
  const d = gitStub(() => "5");
  await assert.rejects(() => getCommitsBehind("/dir", "--output=/etc/passwd", "abc1234def", d), /invalid commit sha/);
  await assert.rejects(() => getCommitsBehind("/dir", "abc1234def", "$(rm -rf)", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0); // never reached git
});

test("getCommitsBehind returns the commit count for valid hex shas", async () => {
  const d = gitStub(() => "12\n");
  assert.equal(await getCommitsBehind("/dir", "abc1234def", "def5678abc", d), 12);
});

test("getCommitsBehind propagates a git error (can't determine — orphaned/force-pushed sha)", async () => {
  const d = gitStub(() => { throw new Error("fatal: unknown revision"); });
  await assert.rejects(() => getCommitsBehind("/dir", "abc1234def", "def5678abc", d), /unknown revision/);
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

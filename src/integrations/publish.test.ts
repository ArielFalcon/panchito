import { test } from "node:test";
import assert from "node:assert/strict";
import { publishE2e, publishCode, PublishDeps } from "./publish";

function deps(status: string, opts: { autoMergeFails?: boolean; mergeFails?: boolean } = {}): PublishDeps & {
  gitCalls: string[][];
  pr: { created: boolean; autoMerged: boolean; directMerged: boolean };
  logs: string[];
} {
  const gitCalls: string[][] = [];
  const logs: string[] = [];
  const pr = { created: false, autoMerged: false, directMerged: false };
  return {
    gitCalls,
    pr,
    logs,
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return status;
      return "";
    },
    createPullRequest: async (_repo, _args) => {
      pr.created = true;
      return { url: "https://github.com/org/app/pull/7", nodeId: "PR_node", number: 7 };
    },
    enableAutoMerge: async () => {
      if (opts.autoMergeFails) throw new Error("auto-merge not allowed");
      pr.autoMerged = true;
    },
    mergePullRequest: async () => {
      if (opts.mergeFails) throw new Error("merge blocked");
      pr.directMerged = true;
    },
    log: (m) => logs.push(m),
  };
}

const input = { repo: "org/app", sha: "abc1234567", mirrorDir: "/mirrors/org__app", baseBranch: "main" };

test("no changes in e2e/ → no PR opened", async () => {
  const d = deps("   \n  ");
  const res = await publishE2e(input, d);
  assert.equal(res, null);
  assert.equal(d.pr.created, false);
  // only queried status; did not commit or push
  assert.deepEqual(d.gitCalls.map((c) => c[0]), ["status"]);
});

test("with changes: branch, commit, push, PR and auto-merge", async () => {
  const d = deps(" M e2e/login.spec.ts");
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  assert.equal(res?.merged, true);
  assert.equal(d.pr.created, true);
  assert.equal(d.pr.autoMerged, true);
  // git operation sequence (the commit carries -c user.* flags up front)
  assert.ok(d.gitCalls.some((c) => c[0] === "status"));
  assert.ok(d.gitCalls.some((c) => c[0] === "checkout" && c.includes("qa/e2e-abc1234")));
  assert.ok(d.gitCalls.some((c) => c[0] === "add"));
  assert.ok(d.gitCalls.some((c) => c.includes("commit")));
  assert.ok(d.gitCalls.some((c) => c.includes("push")));
});

test("when auto-merge is unavailable, falls back to a DIRECT merge (tests actually land)", async () => {
  const d = deps(" M e2e/x.spec.ts", { autoMergeFails: true });
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  assert.equal(d.pr.autoMerged, false); // auto-merge threw
  assert.equal(d.pr.directMerged, true); // ...so we merged directly — the core "commit tests back" promise
  assert.equal(res?.merged, true);
});

test("when BOTH auto-merge and direct merge fail: not merged, loud WARNING, run not broken", async () => {
  const d = deps(" M e2e/x.spec.ts", { autoMergeFails: true, mergeFails: true });
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7"); // PR still opened
  assert.equal(res?.merged, false); // observable: the tests did NOT land
  assert.ok(d.logs.some((l) => /WARNING|not committed back|merge it manually/i.test(l)));
});

test("publishCode: no test changes → no PR", async () => {
  const d = deps("  \n ");
  const res = await publishCode(input, d);
  assert.equal(res, null);
  assert.equal(d.pr.created, false);
});

test("publishCode: commits the whole tree (minus node_modules) on a qa/code- branch", async () => {
  const d = deps(" A src/math.test.ts");
  const res = await publishCode(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  assert.ok(d.gitCalls.some((c) => c[0] === "checkout" && c.includes("qa/code-abc1234")));
    assert.ok(d.gitCalls.some((c) => c[0] === "add" && c.some((a: string) => a.includes("node_modules"))));
  assert.ok(d.gitCalls.some((c) => c.includes("commit") && c.includes("test(code): automated QA for abc1234")));
});

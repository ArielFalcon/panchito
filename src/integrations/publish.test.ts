import { test } from "node:test";
import assert from "node:assert/strict";
import { publishE2e, PublishDeps } from "./publish";

function deps(status: string, opts: { autoMergeFails?: boolean } = {}): PublishDeps & {
  gitCalls: string[][];
  pr: { created: boolean; autoMerged: boolean };
} {
  const gitCalls: string[][] = [];
  const pr = { created: false, autoMerged: false };
  return {
    gitCalls,
    pr,
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
    log: () => {},
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
  assert.equal(d.pr.created, true);
  assert.equal(d.pr.autoMerged, true);
  // git operation sequence (the commit carries -c user.* flags up front)
  assert.ok(d.gitCalls.some((c) => c[0] === "status"));
  assert.ok(d.gitCalls.some((c) => c[0] === "checkout" && c.includes("qa/e2e-abc1234")));
  assert.ok(d.gitCalls.some((c) => c[0] === "add"));
  assert.ok(d.gitCalls.some((c) => c.includes("commit")));
  assert.ok(d.gitCalls.some((c) => c.includes("push")));
});

test("best-effort auto-merge: if it fails, the PR stays open anyway", async () => {
  const d = deps(" M e2e/x.spec.ts", { autoMergeFails: true });
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  assert.equal(d.pr.created, true);
  assert.equal(d.pr.autoMerged, false); // does not break the run
});

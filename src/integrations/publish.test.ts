import { test } from "node:test";
import assert from "node:assert/strict";
import { publishE2e, publishCode, publishContext, PublishDeps } from "./publish";

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

// ── Integration tests: Publish boundary failure modes ───────────────────────

test("publishE2e propagates git checkout failure", async () => {
  const d = deps(" M e2e/x.spec.ts");
  const origStatus = " M e2e/x.spec.ts";
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return origStatus;
    if (args[0] === "checkout") throw new Error("git checkout failed: path conflict");
    return "";
  };
  await assert.rejects(() => publishE2e(input, d), /git checkout failed/);
});

test("publishE2e propagates git push failure", async () => {
  const d = deps(" M e2e/x.spec.ts");
  const origStatus = " M e2e/x.spec.ts";
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return origStatus;
    if (args.includes("push")) throw new Error("git push failed: 403");
    return "";
  };
  await assert.rejects(() => publishE2e(input, d), /git push failed/);
});

test("publishE2e propagates createPullRequest failure", async () => {
  const d = deps(" M e2e/x.spec.ts");
  d.createPullRequest = async () => { throw new Error("GitHub PR creation failed: 422"); };
  await assert.rejects(() => publishE2e(input, d), /GitHub PR creation failed/);
});

test("publishCode propagates git failure", async () => {
  const d = deps(" A src/math.test.ts");
  const origStatus = " A src/math.test.ts";
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return origStatus;
    if (args[0] === "add") throw new Error("git add failed");
    return "";
  };
  await assert.rejects(() => publishCode(input, d), /git add failed/);
});

test("publishContext propagates git commit failure", async () => {
  const d = deps(" M e2e/.qa/context.json");
  const origStatus = " M e2e/.qa/context.json";
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return origStatus;
    if (args.includes("commit")) throw new Error("git commit failed: nothing to commit");
    return "";
  };
  await assert.rejects(() => publishContext(input, d), /git commit failed/);
});

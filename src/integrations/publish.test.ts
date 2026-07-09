import { test } from "node:test";
import assert from "node:assert/strict";
import { publishE2e, publishCode, publishContext, publishE2eSubset, PublishDeps } from "./publish";

function deps(status: string, opts: { autoMergeFails?: boolean; mergeFails?: boolean } = {}): PublishDeps & {
  gitCalls: string[][];
  excludes: string[];
  pr: { created: boolean; autoMerged: boolean; directMerged: boolean };
  logs: string[];
} {
  const gitCalls: string[][] = [];
  const logs: string[] = [];
  let excludes: string[] = [];
  const pr = { created: false, autoMerged: false, directMerged: false };
  return {
    gitCalls,
    get excludes() { return excludes; },
    pr,
    logs,
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return status;
      return "";
    },
    writeExcludes: (_dir, patterns) => { excludes = patterns; },
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

test("publishCode: commits the whole tree on a qa/code- branch, excluding deps via .git/info/exclude", async () => {
  const d = deps(" A src/math.test.ts");
  const res = await publishCode(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  assert.ok(d.gitCalls.some((c) => c[0] === "checkout" && c.includes("qa/code-abc1234")));
  // The add is a PLAIN pathspec (no :(exclude) that would error on an ignored path);
  // node_modules is kept out via local ignore patterns instead.
  assert.ok(d.gitCalls.some((c) => c[0] === "add" && c.includes(".") && !c.some((a: string) => a.startsWith(":(exclude)"))));
  assert.ok(d.excludes.includes("node_modules/"), "node_modules must be excluded via the local ignore file");
  assert.ok(d.gitCalls.some((c) => c.includes("commit") && c.includes("test(code): automated QA for abc1234")));
});

// ── Cross-repo staged context (src/server/service-context.ts) never lands in a published commit ──
// The staged snapshot is a disposable, per-run READ-ONLY copy of a DIFFERENT repo's contracts/diff;
// committing it into e2e/ would bloat the PR with content that belongs to another repo entirely.

test("publishE2e: excludes .qa/service-context/ via the local ignore file", async () => {
  const d = deps(" M e2e/login.spec.ts");
  await publishE2e(input, d);
  assert.ok(d.excludes.includes(".qa/service-context/"), "the staged cross-repo context must never be committed");
});

test("publishCode: excludes e2e/.qa/service-context/ via the local ignore file", async () => {
  const d = deps(" A src/math.test.ts");
  await publishCode(input, d);
  assert.ok(d.excludes.includes("e2e/.qa/service-context/"), "the staged cross-repo context must never be committed in code mode either");
});

// ── Publish boundary failure modes: a side-effect failure must NOT throw out of publish ──
// The run already PASSED; a checkout/push/PR failure must be caught and returned as a
// verdict-preserving result (error set, prUrl null, loud warning) so the runner catch-all
// never overwrites the green verdict with "infra-error" and drops the outcome.

test("publishE2e: git checkout failure is caught — pass preserved, not thrown", async () => {
  const d = deps(" M e2e/x.spec.ts");
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return " M e2e/x.spec.ts";
    if (args[0] === "checkout") throw new Error("git checkout failed: path conflict");
    return "";
  };
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, null);
  assert.equal(res?.merged, false);
  assert.match(res?.error ?? "", /git checkout failed/);
  assert.ok(d.logs.some((l) => /WARNING.*publish.*FAILED/i.test(l)));
});

test("publishE2e: git push failure (e.g. 403) is caught — pass preserved", async () => {
  const d = deps(" M e2e/x.spec.ts");
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return " M e2e/x.spec.ts";
    if (args.includes("push")) throw new Error("git push failed: 403");
    return "";
  };
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, null);
  assert.equal(res?.merged, false);
  assert.match(res?.error ?? "", /git push failed/);
});

test("publishE2e: same-head createPullRequest 422 is caught — pass preserved, not laundered to infra-error", async () => {
  const d = deps(" M e2e/x.spec.ts");
  d.createPullRequest = async () => { throw new Error("GitHub PR error 422: A pull request already exists for org:qa/e2e-abc1234"); };
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, null);
  assert.equal(res?.merged, false);
  assert.match(res?.error ?? "", /already exists/);
});

test("publishCode: git failure is caught — pass preserved", async () => {
  const d = deps(" A src/math.test.ts");
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return " A src/math.test.ts";
    if (args[0] === "add") throw new Error("git add failed");
    return "";
  };
  const res = await publishCode(input, d);
  assert.equal(res?.prUrl, null);
  assert.equal(res?.merged, false);
  assert.match(res?.error ?? "", /git add failed/);
});

// ── publishE2eSubset ──────────────────────────────────────────────────────────

test("publishE2eSubset: non-empty files list → publishChanges called with per-file pathspecs (NOT e2e/)", async () => {
  const d = deps(" M e2e/login.spec.ts");
  const res = await publishE2eSubset(input, ["login.spec.ts"], d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  // Must use explicit per-file pathspecs, not ["e2e"]
  const addCall = d.gitCalls.find((c) => c[0] === "add");
  assert.ok(addCall, "git add should be called");
  // Should include the file explicitly
  assert.ok(addCall!.includes("e2e/login.spec.ts"), "should include the spec file explicitly");
  // Should NOT use directory-wide "e2e" staging
  assert.ok(!addCall!.some((a: string) => a === "e2e"), "should NOT stage the whole e2e/ dir");
});

test("publishE2eSubset: includes DEP_CLOSURE (e2e/.qa/) along with spec files", async () => {
  const d = deps(" M e2e/login.spec.ts");
  await publishE2eSubset(input, ["login.spec.ts"], d);
  const addCall = d.gitCalls.find((c) => c[0] === "add");
  assert.ok(addCall, "git add should be called");
  // DEP_CLOSURE includes e2e/.qa/
  assert.ok(addCall!.includes("e2e/.qa/"), "should include the .qa/ dependency closure");
});

test("publishE2eSubset: no-change-skip → returns null (no PR opened)", async () => {
  const d = deps("  \n  "); // empty status
  const res = await publishE2eSubset(input, ["login.spec.ts"], d);
  assert.equal(res, null);
  assert.equal(d.pr.created, false);
});

test("publishE2eSubset: uses qa/e2e- branch (same naming as publishE2e)", async () => {
  const d = deps(" M e2e/login.spec.ts");
  await publishE2eSubset(input, ["login.spec.ts"], d);
  const checkoutCall = d.gitCalls.find((c) => c[0] === "checkout");
  assert.ok(checkoutCall?.some((a: string) => a.startsWith("qa/e2e-")), "branch should start with qa/e2e-");
});

test("publishE2eSubset: applies E2E_EXCLUDES (same as publishE2e)", async () => {
  const d = deps(" M e2e/login.spec.ts");
  await publishE2eSubset(input, ["login.spec.ts"], d);
  assert.ok(d.excludes.includes("node_modules/"), "should apply node_modules/ exclude");
  assert.ok(d.excludes.includes(".qa/measured.json"), "should apply .qa/measured.json exclude");
});

test("publishE2e (whole-dir) still works unchanged — non-regression", async () => {
  const d = deps(" M e2e/login.spec.ts");
  const res = await publishE2e(input, d);
  assert.equal(res?.prUrl, "https://github.com/org/app/pull/7");
  const addCall = d.gitCalls.find((c) => c[0] === "add");
  // Whole-dir publish uses ["e2e"]
  assert.ok(addCall?.includes("e2e"), "publishE2e should still use e2e/ whole-dir staging");
});

test("publishContext: git commit failure is caught — pass preserved", async () => {
  const d = deps(" M e2e/.qa/context.json");
  d.git = async (args) => {
    d.gitCalls.push(args);
    if (args[0] === "status") return " M e2e/.qa/context.json";
    if (args.includes("commit")) throw new Error("git commit failed: nothing to commit");
    return "";
  };
  const res = await publishContext(input, d);
  assert.equal(res?.prUrl, null);
  assert.equal(res?.merged, false);
  assert.match(res?.error ?? "", /git commit failed/);
});

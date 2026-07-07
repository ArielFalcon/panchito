import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { Sha } from "@kernel/sha.ts";

function runnerReturning(stdout: string, capture?: (r: SandboxedRunRequest) => void): SandboxedBinaryRunner {
  return { run: async (req) => { capture?.(req); return { exitCode: 0, stdout, stderr: "", timedOut: false }; } };
}

// A REAL SandboxedBinaryRunner that shells out to git for real — used only by the merge-commit
// integration test below, where a stub would beg the exact question under test (does the git range
// traverse both merge parents?). Deterministic: git output for a fixed repo is fixed.
const realGitRunner: SandboxedBinaryRunner = {
  run: async (req) => {
    try {
      const stdout = execFileSync(req.command, [...req.args], { cwd: req.cwd, encoding: "utf8", env: { ...req.env, PATH: process.env.PATH ?? "" } });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), timedOut: false };
    }
  },
};

test("diff() shells git with the sha and returns stdout", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("abc1234"));
  assert.equal(out, "DIFF");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("abc1234"));
  assert.equal(seen!.cwd, "/repo");
});

test("blastRadius() returns a Sha-keyed BlastRadius from the parsed diff", async () => {
  const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(diff));
  const br = await adapter.blastRadius(Sha.of("abc1234"));
  assert.deepEqual([...br.changedFiles], ["x.ts"]);
  assert.equal(br.isEmpty, false);
});

test("message() returns the commit message stdout trimmed", async () => {
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("feat: x\n\nbody\n"));
  assert.equal(await adapter.message(Sha.of("abc1234")), "feat: x\n\nbody");
});

test("diff() throws on non-zero exitCode — never returns silent empty diff (CLAUDE.md surface-errors rule)", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad object deadbeef", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.diff(Sha.of("deadbeef")),
    (err: unknown) => err instanceof Error && /fatal: bad object deadbeef/.test(err.message),
    "expected diff() to throw when git exits non-zero",
  );
});

// ── WS7.1 (full-flow remediation, multi-commit range restoration) ──────────────────────────────

test("diff({baseSha}) shells git diff over the explicit baseSha..sha range, not the default sha^", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("RANGE DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") });
  assert.equal(out, "RANGE DIFF");
  assert.ok(seen!.args.includes("bad00001"), "must pass baseSha as the range's lower bound");
  assert.ok(seen!.args.includes("deadbee1"));
  assert.ok(!seen!.args.some((a) => a === "deadbee1^"), "must NOT fall back to the single-commit sha^ form when baseSha is supplied");
});

test("otherMessages() shells git log over the FULL baseSha..sha range (NOT sha^), parses <hash>%x00<message>%x00 records, drops the head, splits NUL-delimited messages", async () => {
  let seen: SandboxedRunRequest | null = null;
  // Record shape now: `<hash>\0<message>\0` per commit. The head (deadbee1...) must be dropped by
  // hash; the other two messages survive. Hashes are full 40-char; the head arg is abbreviated
  // (deadbee1) — the adapter must drop by PREFIX, not exact match.
  const headFull = "deadbee1" + "0".repeat(32);
  const stdout = `${headFull}\0chore: merge feature\n\0abc1230000000000000000000000000000000000\0feat: add x\n\nbody line\0`;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(stdout, (r) => (seen = r)));
  const messages = await adapter.otherMessages(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") });
  assert.deepEqual(messages, ["feat: add x\n\nbody line"], "the head commit's own message is dropped; the merged-branch commit survives");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("bad00001..deadbee1"), "F1 fix: the range must be the FULL baseSha..sha (traverses BOTH merge parents), never baseSha..sha^ (first-parent only)");
  assert.ok(!seen!.args.some((a) => a.endsWith("^")), "must NOT use the first-parent-only sha^ form — that silently drops merged-branch commits");
});

test("otherMessages() returns [] when baseSha equals sha (degenerate/empty range) — no git call needed", async () => {
  let called = false;
  const adapter = new GitMirrorReadAdapter("/repo", { run: async () => { called = true; return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; } });
  const messages = await adapter.otherMessages(Sha.of("aaaaaaa1"), { baseSha: Sha.of("aaaaaaa1") });
  assert.deepEqual(messages, []);
  assert.equal(called, false, "a degenerate range must short-circuit without spawning git");
});

test("otherMessages() throws on non-zero exitCode — never returns a silent empty range", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad revision", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.otherMessages(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") }),
    (err: unknown) => err instanceof Error && /fatal: bad revision/.test(err.message),
  );
});

// F1 fix (adversarial review, MEDIUM): a REAL merge-commit integration test. Builds an actual git
// repo with a merge commit whose second parent (the merged branch) carries a `feat:` commit, then
// asserts that commit's message reaches otherMessages() — the earlier `baseSha..sha^` (first-parent
// only) silently dropped it, which defeated WS7.1's whole purpose for merge-commit pushes.
test("F1 REAL merge commit: otherMessages() reaches the merged-branch commit (second-parent ancestry), and drops the merge head itself", async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-mergetest-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();

    git("init", "-q");
    git("config", "user.email", "t@t.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "chore: base");
    const baseSha = git("rev-parse", "HEAD");
    // Capture the default branch name NOW (varies by git version: master vs main) so we can return
    // to it after the feature branch is done.
    const defaultBranch = git("rev-parse", "--abbrev-ref", "HEAD");

    git("checkout", "-qb", "feature");
    writeFileSync(join(repo, "feature.txt"), "x\n");
    git("add", "feature.txt");
    git("commit", "-qm", "feat: add g in the merged branch");

    // Return to the default branch and merge with --no-ff so a real merge commit (two parents) is
    // created — the head commit's first parent is baseSha, its second parent is the feature commit.
    git("checkout", "-q", defaultBranch);
    git("merge", "-q", "--no-ff", "feature", "-m", "chore: merge feature");
    const mergeSha = git("rev-parse", "HEAD");

    const adapter = new GitMirrorReadAdapter(repo, realGitRunner);
    const messages = await adapter.otherMessages(Sha.of(mergeSha), { baseSha: Sha.of(baseSha) });

    assert.ok(
      messages.some((m) => m.startsWith("feat: add g in the merged branch")),
      `the merged-branch feat commit must reach otherMessages() via second-parent ancestry — got: ${JSON.stringify(messages)}`,
    );
    assert.ok(
      !messages.some((m) => m.startsWith("chore: merge feature")),
      "the merge head's own message must be dropped (it comes via message(sha), not otherMessages())",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

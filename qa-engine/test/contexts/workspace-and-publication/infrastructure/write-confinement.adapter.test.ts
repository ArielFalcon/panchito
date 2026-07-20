// test/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.test.ts
//
// sdd/migration-remediation, Slice 3 (P0 write-confinement wiring, D-P0b). Task 3.1: covers all 6
// spec scenarios (sdd/migration-remediation/spec, domain "write-confinement") using injected fake
// Git + realpathSync + isSymlink, mirroring src/qa/confinement.test.ts's own established
// runConfinement fixture style (the legacy behavioral oracle this adapter faithfully ports). A
// second section adds REAL throwaway-git-fixture tests (mkdtempSync + execFileSync), matching the
// harness pattern src/server/rewritten-engine-factory.publish-excludes.test.ts established for
// Slice 2 — proving the adapter's git-restore/git-clean calls actually revert real files, not just
// that the right argv was recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteConfinementAdapter, type WriteConfinementAdapterDeps } from "@contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts";

// ── fake-git fixture (task 3.1) ─────────────────────────────────────────────────────────────────

function makeDeps(statusOut: string, gitCalls: Array<string[]>): WriteConfinementAdapterDeps {
  return {
    git: async (args, _cwd) => {
      gitCalls.push(args);
      if (args[0] === "status") return statusOut;
      return "";
    },
    realpath: (p) => p, // identity: no symlink escapes unless a test overrides this
    isSymlink: () => false, // nothing is a symlink unless a test overrides this
  };
}

test("Scenario: out-of-area write is reverted (e2e target)", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  src/config.ts\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", false);

  assert.equal(result.strays, 1);
  assert.equal(result.dangerous, 0);
  assert.deepEqual(result.reverted, ["src/config.ts"]);
  const restoreCall = gitCalls.find((a) => a[0] === "restore");
  assert.deepEqual(
    restoreCall,
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", "src/config.ts"],
    "revert must be staged-aware (unstage + restore worktree from HEAD), matching runConfinement's own git semantics",
  );
  assert.equal(gitCalls.find((a) => a[0] === "clean"), undefined);
});

test("Scenario: denylisted write is reverted (code target)", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  .env.local\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", true);

  assert.equal(result.strays, 1, ".env.local is denied on the code target");
  assert.equal(result.dangerous, 1, ".env.local is a dangerous (secret) path");
  assert.deepEqual(result.reverted, [".env.local"]);
});

test("Scenario: escaping symlink is reverted regardless of target (e2e target)", async () => {
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  const escapedReal = "/outside/the/mirror/target";
  const deps: WriteConfinementAdapterDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return "M  e2e/link-out\n";
      return "";
    },
    realpath: (p) => (p === join(mirrorDir, "e2e/link-out") ? escapedReal : p),
    isSymlink: (p) => p === join(mirrorDir, "e2e/link-out"),
  };
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce(mirrorDir, false);

  assert.equal(result.dangerous, 1, "an escaping symlink must be counted as dangerous");
  assert.ok(result.reverted.includes("e2e/link-out"));
});

test("Scenario: escaping symlink is reverted regardless of target (code target)", async () => {
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  const deps: WriteConfinementAdapterDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return "M  src/link-out\n"; // not denied by name — dangerous only by resolution
      return "";
    },
    realpath: (p) => (p === join(mirrorDir, "src/link-out") ? "/etc/passwd" : p),
    isSymlink: (p) => p === join(mirrorDir, "src/link-out"),
  };
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce(mirrorDir, true);

  assert.equal(result.dangerous, 1, "the escaping symlink must be dangerous on the code target too (publishCode stages '.')");
  assert.ok(result.reverted.includes("src/link-out"));
});

test("Scenario (negative): legitimate e2e spec write survives", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  e2e/checkout.spec.ts\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", false);

  assert.equal(result.strays, 0, "an e2e/-rooted path is never a stray on the e2e target");
  assert.deepEqual(result.reverted, []);
  assert.equal(gitCalls.find((a) => a[0] !== "status"), undefined, "no revert call for a legitimate write");
});

test("Scenario (negative): legitimate code-mode non-denylisted test file survives", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("?? tests/new_order_test.go\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", true);

  assert.equal(result.strays, 0, "a non-denylisted repo-root path is never a stray on the code target");
  assert.deepEqual(result.reverted, []);
});

test("Scenario (negative): e2e/.qa/manifest.json survives on the e2e target", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  e2e/.qa/manifest.json\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", false);

  assert.equal(result.strays, 0);
  assert.deepEqual(result.reverted, []);
});

test("Scenario (negative): e2e/.qa/manifest.json survives on the code target", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  e2e/.qa/manifest.json\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", true);

  assert.equal(result.strays, 0, "manifest.json matches no CONFINEMENT_DENYLIST entry");
  assert.deepEqual(result.reverted, []);
});

test("clean working copy -> zero strays, no revert calls beyond status", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", false);

  assert.equal(result.strays, 0);
  assert.equal(result.dangerous, 0);
  assert.deepEqual(result.reverted, []);
  assert.equal(gitCalls.length, 1, "only the status call should have been made");
});

test("a path that is BOTH a denied secret AND an escaping symlink counts dangerous exactly once (dedup)", async () => {
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  const deps: WriteConfinementAdapterDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return "M  .env.local\n";
      return "";
    },
    realpath: (p) => (p === join(mirrorDir, ".env.local") ? "/etc/secrets" : p),
    isSymlink: (p) => p === join(mirrorDir, ".env.local"),
  };
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce(mirrorDir, true);

  assert.equal(result.dangerous, 1, "must be deduped to 1, not 2");
  assert.equal(result.strays, 1);
  assert.deepEqual(result.reverted, [".env.local"]);
});

test("untracked stray -> git clean called (not restore), dangerous counted for a secret", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("?? secret.env\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const result = await adapter.enforce("/mirror", false);

  assert.equal(result.strays, 1);
  assert.equal(result.dangerous, 1);
  const cleanCall = gitCalls.find((a) => a[0] === "clean");
  assert.ok(cleanCall?.includes("secret.env"));
  assert.equal(gitCalls.find((a) => a[0] === "restore"), undefined);
});

test("an already-aborted signal short-circuits to a no-op result (no git calls at all)", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  src/config.ts\n", gitCalls);
  const adapter = new WriteConfinementAdapter(deps);
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.enforce("/mirror", false, controller.signal);

  assert.deepEqual(result, { strays: 0, dangerous: 0, reverted: [] });
  assert.equal(gitCalls.length, 0, "an aborted signal must short-circuit before any git call");
});

test("a thrown git error (failed revert) is NOT swallowed by the adapter — it propagates (fault isolation is the use-case's job, not this adapter's)", async () => {
  const deps: WriteConfinementAdapterDeps = {
    git: async (args) => {
      if (args[0] === "status") return "M  src/config.ts\n";
      throw new Error("git restore failed: permission denied");
    },
    realpath: (p) => p,
    isSymlink: () => false,
  };
  const adapter = new WriteConfinementAdapter(deps);

  await assert.rejects(() => adapter.enforce("/mirror", false), /permission denied/);
});

// ── real throwaway-git-fixture (matches rewritten-engine-factory.publish-excludes.test.ts's harness) ──

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "qa-confinement-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  mkdirSync(join(repo, "e2e"), { recursive: true });
  writeFileSync(join(repo, "e2e", "existing.spec.ts"), "test('x', () => {});\n");
  git("add", "-A");
  git("commit", "-qm", "chore: base");
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

test("real git fixture: an out-of-area write is ACTUALLY reverted from disk (e2e target)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "src.ts"), "export const leaked = true;\n");
    const adapter = new WriteConfinementAdapter({ git: realGitFn(repo), realpath: realpathSync, isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } } });

    const result = await adapter.enforce(repo, false);

    assert.equal(result.strays, 1);
    assert.deepEqual(result.reverted, ["src.ts"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the stray file must actually be removed from the working tree, not just reported");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a denylisted write is ACTUALLY reverted from disk (code target)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\n");
    const adapter = new WriteConfinementAdapter({ git: realGitFn(repo), realpath: realpathSync, isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } } });

    const result = await adapter.enforce(repo, true);

    assert.equal(result.strays, 1);
    assert.deepEqual(result.reverted, ["Dockerfile"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "Dockerfile must actually be removed, not just flagged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a real escaping symlink is detected via realpathSync and reverted", async () => {
  const repo = initRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), "qa-confinement-outside-"));
  try {
    const outsideTarget = join(outsideDir, "secret.txt");
    writeFileSync(outsideTarget, "outside\n");
    symlinkSync(outsideTarget, join(repo, "src-link"));
    const adapter = new WriteConfinementAdapter({ git: realGitFn(repo), realpath: realpathSync, isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } } });

    const result = await adapter.enforce(repo, true);

    assert.equal(result.dangerous, 1, "a real symlink resolving outside the repo must be flagged dangerous");
    assert.ok(result.reverted.includes("src-link"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("real git fixture: legitimate writes (e2e spec + e2e/.qa/manifest.json) survive a real enforce() pass", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "e2e", "checkout.spec.ts"), "test('checkout', () => {});\n");
    mkdirSync(join(repo, "e2e", ".qa"), { recursive: true });
    writeFileSync(join(repo, "e2e", ".qa", "manifest.json"), "{}\n");
    const adapter = new WriteConfinementAdapter({ git: realGitFn(repo), realpath: realpathSync, isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } } });

    const result = await adapter.enforce(repo, false);

    assert.equal(result.strays, 0);
    assert.deepEqual(result.reverted, []);
    // --untracked-files=all (matching the adapter's OWN status call) — plain --porcelain collapses
    // an untracked directory to its bare dir path (e.g. "?? e2e/.qa/"), which would make this
    // assertion pass vacuously even if the file inside had been wrongly reverted.
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
    assert.ok(status.includes("e2e/checkout.spec.ts"), "the legitimate spec must remain on disk (untouched)");
    assert.ok(status.includes("e2e/.qa/manifest.json"), "the manifest must remain on disk (untouched)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── staged-rename over-revert regression (Judgment Day round 1) ────────────────────────────────
//
// A `git status --porcelain` rename/copy line (`R  old -> new`) used to collapse into ONE
// ParsedChange keeping only the NEW path. enforce() then reverted only that path via
// `git restore --staged --worktree --source=HEAD -- <new>`; since HEAD has no <new>, the staged
// rename degraded to an ORPHANED staged deletion of <old> — the legitimate file vanished from disk
// and would have been committed as deleted by the next publish. These tests pin the fix: both
// sides of a reverted rename must be restored/removed TOGETHER, and a rename fully inside the
// allowed area must survive untouched.

test("real git fixture: staged rename out of e2e/ reverts BOTH sides — stray removed, legitimate origin restored intact (e2e target)", async () => {
  const repo = initRepo();
  try {
    execFileSync("git", ["mv", "e2e/existing.spec.ts", "stray.spec.ts"], { cwd: repo });
    const preStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith("R "), "precondition: git must report a staged rename, not two independent D/A lines");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted.slice().sort(), ["e2e/existing.spec.ts", "stray.spec.ts"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean — no orphaned staged deletion of the legitimate origin");
    assert.equal(existsSync(join(repo, "stray.spec.ts")), false, "the stray destination must be gone");
    assert.equal(
      readFileSync(join(repo, "e2e", "existing.spec.ts"), "utf8"),
      "test('x', () => {});\n",
      "the legitimate origin must be restored on disk with its original content, not left missing or re-added empty",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture (negative): a rename fully INSIDE e2e/ is not a stray — neither side reverted", async () => {
  const repo = initRepo();
  try {
    execFileSync("git", ["mv", "e2e/existing.spec.ts", "e2e/renamed.spec.ts"], { cwd: repo });

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, false);

    assert.equal(result.strays, 0, "a rename entirely within the allowed e2e/ area is a legitimate agent write, not a stray");
    assert.deepEqual(result.reverted, []);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "R  e2e/existing.spec.ts -> e2e/renamed.spec.ts", "the rename must survive untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── escape-scan rename-awareness regression (Judgment Day round 2) ─────────────────────────────
//
// The escape-scan loop (BOTH targets) destructured only `{ xy, path }`, dropping
// `renameCounterpart`. A rename fully inside the allowed area (both sides pass classifyStrays
// untouched) whose NEW side is a symlink escaping the mirror only pushed the new side into the
// revert bucket: `git restore --staged --worktree --source=HEAD -- <new>` then leaves the old
// side's staged deletion orphaned — the exact destructive pattern the round-1 fix closed via
// classifyStrays, reopened here via the second code path that never got the same treatment.

test("real git fixture: staged rename of an escaping symlink INSIDE e2e/ reverts BOTH sides — rename fully undone (e2e target)", async () => {
  const repo = initRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), "qa-confinement-outside-"));
  try {
    const outsideTarget = join(outsideDir, "secret.txt");
    writeFileSync(outsideTarget, "outside\n");
    symlinkSync(outsideTarget, join(repo, "e2e", "link-old"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: add escaping symlink"], { cwd: repo });

    execFileSync("git", ["mv", "e2e/link-old", "e2e/link-new"], { cwd: repo });
    const preStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith("R "), "precondition: git must report a staged rename, not two independent D/A lines");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted.slice().sort(), ["e2e/link-new", "e2e/link-old"].sort());
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean — no orphaned staged deletion of the legitimate origin");
    assert.equal(existsSync(join(repo, "e2e", "link-new")), false, "the renamed destination must be gone");
    assert.ok(
      lstatSync(join(repo, "e2e", "link-old")).isSymbolicLink(),
      "the original symlink must be restored intact at its original path, not left missing",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("real git fixture: staged rename of an escaping symlink reverts BOTH sides — rename fully undone (code target)", async () => {
  const repo = initRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), "qa-confinement-outside-"));
  try {
    const outsideTarget = join(outsideDir, "secret.txt");
    writeFileSync(outsideTarget, "outside\n");
    symlinkSync(outsideTarget, join(repo, "link-old"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: add escaping symlink"], { cwd: repo });

    execFileSync("git", ["mv", "link-old", "link-new"], { cwd: repo });
    const preStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith("R "), "precondition: git must report a staged rename, not two independent D/A lines");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, true);

    assert.deepEqual(result.reverted.slice().sort(), ["link-new", "link-old"].sort());
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean — no orphaned staged deletion of the legitimate origin");
    assert.equal(existsSync(join(repo, "link-new")), false, "the renamed destination must be gone");
    assert.ok(
      lstatSync(join(repo, "link-old")).isSymbolicLink(),
      "the original symlink must be restored intact at its original path, not left missing",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("real git fixture: rename INTO a denylisted destination reverts BOTH sides — destination removed, legitimate origin restored (code target)", async () => {
  const repo = initRepo();
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: add legit.ts"], { cwd: repo });
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    execFileSync("git", ["mv", "src/legit.ts", ".github/workflows/x.yml"], { cwd: repo });

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, true);

    assert.deepEqual(result.reverted.slice().sort(), [".github/workflows/x.yml", "src/legit.ts"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean");
    assert.equal(existsSync(join(repo, ".github", "workflows", "x.yml")), false, "the denylisted destination must be gone");
    assert.equal(
      readFileSync(join(repo, "src", "legit.ts"), "utf8"),
      "export const x = 1;\n",
      "the legitimate origin must be restored intact",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── quote-aware rename-arrow parsing regression (Judgment Day round 2) ─────────────────────────
//
// git C-style-quotes a rename's OLD path whenever it literally contains " -> " (to disambiguate
// from the rename separator). parseStatusOutput's arrow split used a first-match `indexOf`, which
// broke inside such a quoted span. This end-to-end fixture proves the adapter still reverts BOTH
// sides of a real staged rename whose origin filename contains " -> ", not just the unit test on
// the parser in isolation.

test("real git fixture: staged rename OUT of e2e/ whose origin filename contains ' -> ' reverts BOTH sides intact (e2e target)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "e2e", "weird -> name.spec.ts"), "test('weird', () => {});\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: add weirdly named spec"], { cwd: repo });

    execFileSync("git", ["mv", "e2e/weird -> name.spec.ts", "stray.spec.ts"], { cwd: repo });
    const preStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith("R "), "precondition: git must report a staged rename");
    assert.ok(preStatus.includes('"e2e/weird -> name.spec.ts"'), "precondition: git must C-style-quote the origin path");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted.slice().sort(), ["e2e/weird -> name.spec.ts", "stray.spec.ts"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean — no orphaned staged deletion of the legitimate origin");
    assert.equal(existsSync(join(repo, "stray.spec.ts")), false, "the stray destination must be gone");
    assert.equal(
      readFileSync(join(repo, "e2e", "weird -> name.spec.ts"), "utf8"),
      "test('weird', () => {});\n",
      "the legitimate origin (whose name literally contains ' -> ') must be restored on disk with its original content",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── C-style quote decoding regression (Judgment Day round 3) ───────────────────────────────────
//
// With git's DEFAULT core.quotePath=true, `git status --porcelain` octal-escapes any non-ASCII
// byte in a path (e.g. `café.spec.ts` -> `"caf\303\251.spec.ts"`). stripQuotes only stripped the
// surrounding `"`, leaving the literal escape sequence `\303\251` in the returned path string. The
// subsequent revert (`git clean -f -- "caf\303\251-leak.ts"`, or `git restore -- ...`) then matches
// NOTHING on disk — enforce() reports the stray as reverted while the file survives, a silent
// security-boundary bypass reachable with any accented filename under git's default config.

test("real git fixture: an untracked non-ASCII stray at repo root is ACTUALLY deleted from disk (e2e target)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "café-leak.ts"), "export const leaked = true;\n");
    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });

    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted, ["café-leak.ts"], "reverted[] must carry the decoded literal name, not the raw octal escape");
    assert.equal(existsSync(join(repo, "café-leak.ts")), false, "the non-ASCII stray must actually be gone from disk, not just reported as reverted");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a tracked non-ASCII file inside e2e/ staged-renamed OUT of e2e/ reverts BOTH sides intact (e2e target)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "e2e", "café.spec.ts"), "test('café', () => {});\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: add non-ASCII spec"], { cwd: repo });

    execFileSync("git", ["mv", "e2e/café.spec.ts", "café-stray.spec.ts"], { cwd: repo });
    const preStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith("R "), "precondition: git must report a staged rename");
    assert.ok(preStatus.includes("\\303\\251"), "precondition: git must octal-escape the non-ASCII byte under core.quotePath=true");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted.slice().sort(), ["café-stray.spec.ts", "e2e/café.spec.ts"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean — no orphaned staged deletion of the legitimate origin");
    assert.equal(existsSync(join(repo, "café-stray.spec.ts")), false, "the stray destination must be gone");
    assert.equal(
      readFileSync(join(repo, "e2e", "café.spec.ts"), "utf8"),
      "test('café', () => {});\n",
      "the legitimate non-ASCII origin must be restored on disk with its original content, via a decoded path git restore can actually match",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Judgment Day round 3, judge A: an embedded literal double-quote in a filename is itself
// C-style-escaped by git (`"` -> `\"`) inside the surrounding quotes — a DIFFERENT escape shape
// than the octal non-ASCII case above, exercised here end-to-end to confirm the decoded literal
// path (containing a real `"` character) is what actually reaches git, not the still-escaped form.
// ── literal-byte corruption regression (Judgment Day round 4) ──────────────────────────────────
//
// Under `core.quotePath=false`, git still C-style-quotes a path for reasons OTHER than non-ASCII
// bytes (here: an embedded space) but leaves the non-ASCII bytes literal inside the quotes instead
// of octal-escaping them (as it would under the default core.quotePath=true, round 3's fix). The
// old literal-character branch of decodeQuoted pushed a raw UTF-16 code unit as a single byte —
// invalid standalone UTF-8 for a non-ASCII char — corrupting the decoded path so the revert
// pathspec matched nothing on disk, the same silent-bypass class as round 3.
test("real git fixture: an untracked stray needing quoting for an embedded space AND a literal non-ASCII char is ACTUALLY deleted from disk under core.quotePath=false (e2e target)", async () => {
  const repo = initRepo();
  try {
    execFileSync("git", ["config", "core.quotePath", "false"], { cwd: repo });
    const strayName = "weird café file.ts";
    writeFileSync(join(repo, strayName), "export const leaked = true;\n");
    const preStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.startsWith('?? "'), "precondition: git must still quote this path (embedded space) under core.quotePath=false");
    assert.ok(preStatus.includes("café"), "precondition: the non-ASCII bytes must be literal (not octal-escaped) under core.quotePath=false");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });

    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted, [strayName], "reverted[] must carry the true decoded name, not a corrupted one");
    assert.equal(existsSync(join(repo, strayName)), false, "the stray must actually be gone from disk, not just reported as reverted");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: an untracked stray whose filename contains an embedded quote is ACTUALLY deleted from disk (e2e target)", async () => {
  const repo = initRepo();
  try {
    const strayName = 'weird"quote-leak.ts';
    writeFileSync(join(repo, strayName), "export const leaked = true;\n");
    const preStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
    assert.ok(preStatus.includes('\\"quote-leak.ts'), "precondition: git must escape the embedded quote inside the quoted path");

    const adapter = new WriteConfinementAdapter({
      git: realGitFn(repo),
      realpath: realpathSync,
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });

    const result = await adapter.enforce(repo, false);

    assert.deepEqual(result.reverted, [strayName], "reverted[] must carry the decoded literal name (a real embedded quote), not the escaped form");
    assert.equal(existsSync(join(repo, strayName)), false, "the stray must actually be gone from disk");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.trim(), "", "the tree must be fully clean");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

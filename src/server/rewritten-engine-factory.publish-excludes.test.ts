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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

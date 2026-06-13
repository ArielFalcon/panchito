// Local working copy of the watched repos. Note: it is READ-ONLY for the agent
// (read code with Serena, extract the diff) and WRITE-ONLY for the `e2e/` folder
// (the tests, committed via PR). The app is never built or started: the system
// under test is the DEV environment. git/exists are injected so the logic is
// verifiable without touching disk or network in tests.

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  root?: string;
}

function workdirRoot(): string {
  return process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors");
}

// The remote URL NEVER carries a credential. git persists the clone URL into the
// mirror's .git/config, and the mirrors volume is mounted into the agent container
// (the agent's session cwd, with bash/read tools) — a token in the URL would hand
// the push credential to the LLM and to untrusted watched-repo lifecycle scripts.
// Auth happens exclusively through the transient -c insteadOf rewrite (authHeaderArgs).
function tokenlessUrl(repo: string): string {
  const base = process.env.GIT_REMOTE_BASE ?? "https://github.com";
  return `${base}/${repo}.git`;
}

// A commit SHA passed to git as a positional arg MUST be a hex id. A hex 7–40 string
// can never be parsed as a git option (e.g. `--output=...`), which closes the
// git-argument-injection surface from an attacker-controlled webhook/API sha.
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
export function assertHexSha(sha: string): void {
  if (!HEX_SHA.test(sha)) throw new Error(`invalid commit sha (must be 7–40 hex chars): ${JSON.stringify(sha)}`);
}

// Token-in-URL auth via -c url.insteadOf. When GITHUB_TOKEN is set, all https://github.com
// URLs are transparently rewritten to https://x-access-token:TOKEN@github.com — no credential
// helper involved, no token in .git/config, works on every OS.
export function authHeaderArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? ["-c", `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`]
    : [];
}

// Brings the mirror up to date with origin: tokenless clone when missing, fetch when
// present. On the existing-dir path it first self-heals two failure modes:
//   1. A stale `.git/index.lock` — the queue is strictly sequential and only the
//      orchestrator performs git writes, so any lock present here was left by an
//      abruptly-interrupted run and would otherwise poison every later run.
//   2. A token embedded in origin's URL — mirrors cloned before the tokenless-URL
//      policy persist the credential in .git/config; `remote set-url` (idempotent,
//      cheap) scrubs it on the next run.
async function syncMirror(repo: string, deps: MirrorDeps): Promise<string> {
  const root = deps.root ?? workdirRoot();
  const dir = join(root, repo.replaceAll("/", "__"));
  if (!deps.exists(dir)) {
    await deps.git([...authHeaderArgs(), "clone", tokenlessUrl(repo), dir]);
  } else {
    const indexLock = join(dir, ".git", "index.lock");
    if (deps.exists(indexLock)) deps.removeFile(indexLock);
    await deps.git(["remote", "set-url", "origin", tokenlessUrl(repo)], dir);
    await deps.git([...authHeaderArgs(), "fetch", "origin"], dir);
  }
  return dir;
}

// Leaves the working copy PRISTINE at the SHA. `checkout -f` discards changes to
// tracked files (e.g. `e2e/` touched by a previous run that did not publish) and
// `clean -fd` removes untracked files (leftover specs), EXCEPT node_modules so
// the e2e project's deps are not reinstalled on every run. Without this, runs
// that do not publish would contaminate the next one (or break the checkout).
export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  assertHexSha(sha);
  const dir = await syncMirror(repo, deps);
  await deps.git(["checkout", "-f", sha], dir);
  await deps.git(["clean", "-fd", "-e", "node_modules"], dir);
  return dir;
}

// A branch name passed to git as a positional arg must never be parseable as an
// option (no leading '-') nor as a rev range ('..'). Same injection-closing rationale
// as assertHexSha for SHAs coming from an attacker-controlled webhook.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function assertBranchName(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

// Pristine working copy at the HEAD of origin/<branch> (not at a specific SHA).
// Used for the PRIMARY repo of a cross-repo run: the triggering commit belongs to a
// service repo, so the front is checked out at its own base branch instead.
export async function ensureMirrorAtBranch(repo: string, branch: string, deps: MirrorDeps): Promise<string> {
  assertBranchName(branch);
  const dir = await syncMirror(repo, deps);
  await deps.git(["checkout", "-f", `origin/${branch}`], dir);
  await deps.git(["clean", "-fd", "-e", "node_modules"], dir);
  return dir;
}

// Diff of commit `sha` against its parent (content only, without the header).
// A MERGE commit has 2+ parents, and `git show` emits an EMPTY diff for it by default —
// which would blind both commit classification and change-coverage to the merge's blast
// radius. Merging a PR into the default branch is the canonical "commit deployed to DEV"
// event, so this case is the rule, not the exception: diff against the FIRST parent so
// the net change the merge introduced is visible.
export async function getCommitDiff(dir: string, sha: string, deps: MirrorDeps, commits = 1): Promise<string> {
  assertHexSha(sha);
  // Multi-commit window: the cumulative diff of the last `commits` commits ending at sha
  // (sha~N..sha) — analyze a short series as one blast radius instead of just the tip.
  if (commits > 1) {
    return deps.git(["diff", `${sha}~${commits}`, sha], dir);
  }
  const parents = (await deps.git(["show", "-s", "--format=%P", sha], dir)).trim().split(/\s+/).filter(Boolean);
  if (parents.length > 1) {
    return deps.git(["show", "--format=", "-m", "--first-parent", sha], dir);
  }
  return deps.git(["show", "--format=", sha], dir);
}

// The *.spec.ts files the agent actually wrote/modified this run, derived from `git
// status` over e2eRelDir (added, modified, untracked). Returned e2e-relative (e.g.
// "flows/login.spec.ts"), excluding the seed `cleanup.spec.ts`. This is the
// AUTHORITATIVE spec set: the orchestrator trusts the working copy, never the agent's
// self-reported list (which can name files it did not write, or omit files it did).
//
// `--untracked-files=all` is REQUIRED, not cosmetic: when the whole e2e/ folder is itself
// untracked — every FIRST run on a newly-onboarded app, where the seed was just bootstrapped
// into a repo that has no committed e2e/ — plain `git status --porcelain` collapses it to a
// single `?? e2e/` line and never names the .spec.ts files inside, so the agent's real specs
// read as "0 on disk" and the run falsely returns `skipped`. `-uall` recurses into untracked
// directories and lists each file, so the specs are seen on the first run too.
export async function listChangedSpecs(dir: string, e2eRelDir: string, deps: MirrorDeps): Promise<string[]> {
  const out = await deps.git(["status", "--porcelain", "--untracked-files=all", "--", e2eRelDir], dir);
  return out
    .split("\n")
    .filter((l) => l.length > 3) // "XY path" — 2 status chars + a space + the path
    .map((l) => l.slice(3))
    .map((p) => {
      const i = p.indexOf(" -> "); // a rename reports "old -> new"; take the new path
      return i >= 0 ? p.slice(i + 4) : p;
    })
    .filter((p) => p.endsWith(".spec.ts") && !p.endsWith("cleanup.spec.ts"))
    .map((p) => (p.startsWith(e2eRelDir + "/") ? p.slice(e2eRelDir.length + 1) : p));
}

// Commit message (subject + body): provides the INTENT used to classify the change.
export async function getCommitMessage(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  assertHexSha(sha);
  return deps.git(["show", "-s", "--format=%B", sha], dir);
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    // SECURITY: the orchestrator operates on UNTRUSTED working copies (watched repos, and — in
    // code mode — trees that an unprivileged sandbox user has written to). A commit/push/checkout
    // would otherwise run that repo's hooks AS THE ORCHESTRATOR (root): a sandbox-planted
    // `.git/hooks/pre-commit` is a root-RCE escape. `-c core.hooksPath=/dev/null` on the COMMAND
    // LINE disables all hooks and cannot be overridden by the repo's own .git/config. The
    // orchestrator never relies on a repo's hooks, so this is uniformly safe.
    const hardened = ["-c", "core.hooksPath=/dev/null", ...args];
    execFile("git", hardened, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export const defaultMirrorDeps: MirrorDeps = {
  git: realGit,
  exists: existsSync,
  removeFile: (path) => rmSync(path, { force: true }),
};

// Resolves a symbolic ref (branch/tag) to a concrete SHA via git ls-remote.
// Auth flows through the -c insteadOf rewrite: the rewritten URL carries inline
// credentials, so no credential helper is consulted (no terminal → no prompt) and
// the URL argument itself stays tokenless.
export async function resolveRef(repo: string, ref: string, deps: MirrorDeps): Promise<string> {
  const stdout = await deps.git([...authHeaderArgs(), "ls-remote", tokenlessUrl(repo), ref]);
  const sha = stdout.split(/\s/)[0];
  if (!sha || sha.length < 40) throw new Error(`no SHA resolved for ${ref}`);
  return sha;
}

// How many commits is `headSha` ahead of `fromSha`? Returns 0 when fromSha is not
// an ancestor (history diverged) or when the SHAs are equal. Used by staleness
// detection for the context map.
export async function getCommitsBehind(
  mirrorDir: string,
  fromSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<number> {
  // Both SHAs are interpolated into a git revspec (`fromSha..headSha`). assertHexSha
  // guarantees they cannot be parsed as git options — closing the same injection surface
  // the rest of this module defends (the context map's builtAtSha is repo-controlled).
  assertHexSha(fromSha);
  assertHexSha(headSha);
  // Do NOT swallow a git error into 0: an orphaned/force-pushed fromSha makes `rev-list`
  // fail, and reporting "0 behind" would silently claim the map is fresh. Let it throw so
  // the caller can warn "could not verify" (fail-loud) instead of pretending freshness.
  const stdout = await deps.git(["rev-list", "--count", `${fromSha}..${headSha}`], mirrorDir);
  const n = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`unexpected rev-list output: ${JSON.stringify(stdout.trim().slice(0, 40))}`);
  return n;
}

// Local working copy of the watched repos. Note: it is READ-ONLY for the agent
// (read code with Serena, extract the diff) and WRITE-ONLY for the `e2e/` folder
// (the tests, committed via PR). The app is never built or started: the system
// under test is the DEV environment. git/exists are injected so the logic is
// verifiable without touching disk or network in tests.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  root?: string;
}

function workdirRoot(): string {
  return process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors");
}

function remoteUrl(repo: string): string {
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

// Ephemeral header auth (-c http.extraHeader) with credential helper disabled.
// -c credential.helper= prevents macOS osxkeychain from intercepting auth and
// prompting for a username (no terminal → crash). The token lives in argv (not
// persisted in .git/config), which is acceptable for ephemeral commands.
export function authHeaderArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "-c", "credential.helper="]
    : [];
}

// Leaves the working copy PRISTINE at the SHA. `checkout -f` discards changes to
// tracked files (e.g. `e2e/` touched by a previous run that did not publish) and
// `clean -fd` removes untracked files (leftover specs), EXCEPT node_modules so
// the e2e project's deps are not reinstalled on every run. Without this, runs
// that do not publish would contaminate the next one (or break the checkout).
export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  assertHexSha(sha);
  const root = deps.root ?? workdirRoot();
  const dir = join(root, repo.replaceAll("/", "__"));
  if (!deps.exists(dir)) {
    await deps.git([...authHeaderArgs(), "clone", remoteUrl(repo), dir]);
  } else {
    await deps.git([...authHeaderArgs(), "fetch", "origin"], dir);
  }
  await deps.git(["checkout", "-f", sha], dir);
  await deps.git(["clean", "-fd", "-e", "node_modules"], dir);
  return dir;
}

// Diff of commit `sha` against its parent (content only, without the header).
// A MERGE commit has 2+ parents, and `git show` emits an EMPTY diff for it by default —
// which would blind both commit classification and change-coverage to the merge's blast
// radius. Merging a PR into the default branch is the canonical "commit deployed to DEV"
// event, so this case is the rule, not the exception: diff against the FIRST parent so
// the net change the merge introduced is visible.
export async function getCommitDiff(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  assertHexSha(sha);
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
export async function listChangedSpecs(dir: string, e2eRelDir: string, deps: MirrorDeps): Promise<string[]> {
  const out = await deps.git(["status", "--porcelain", "--", e2eRelDir], dir);
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
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export const defaultMirrorDeps: MirrorDeps = { git: realGit, exists: existsSync };

// Resolves a symbolic ref (branch/tag) to a concrete SHA via git ls-remote.
// Embeds GITHUB_TOKEN directly in the URL to bypass credential helpers that would
// otherwise intercept auth and prompt for a username (no terminal → crash).
export async function resolveRef(repo: string, ref: string, deps: MirrorDeps): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  const url = token ? `https://x-access-token:${token}@github.com/${repo}.git` : remoteUrl(repo);
  const stdout = await deps.git(["ls-remote", url, ref]);
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

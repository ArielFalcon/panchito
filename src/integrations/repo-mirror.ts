// Local working copy of the watched repos. Note: it is READ-ONLY for the agent
// (read code with Serena, extract the diff) and WRITE-ONLY for the `e2e/` folder
// (the tests, committed via PR). The app is never built or started: the system
// under test is the DEV environment. git/exists are injected so the logic is
// verifiable without touching disk or network in tests.
//
// migration-tier-4a: the provisioning ARGV ensureMirror/ensureMirrorAtBranch actually RUN (clone/
// fetch/checkout-f/clean, index.lock+set-url self-heal) now lives in qa-engine's src-free
// MirrorProvisionAdapter. This module stays the credentialed-git supplier — realGit/authHeaderArgs/
// tokenlessUrl/hardenGitArgs/scrubGitError/assertHexSha/assertBranchName never leave src — and keeps
// exporting `ensureMirror`/`ensureMirrorAtBranch` with their ORIGINAL byte-identical public signature
// `(repo, sha|branch, deps: MirrorDeps): Promise<string>` as THIN WRAPPERS that adapt MirrorDeps into
// MirrorProvisionDeps and delegate. The wrapper is required, not cosmetic: src/index.ts's onboarding
// job calls `ensureMirrorAtBranch` directly (a SECOND production consumer beyond the composition
// factory's checkout closure) — re-verified against HEAD before this slice, since the migration
// design's decision table did not originally account for it. The decorated `git` fn prepends
// authHeaderArgs() for clone/fetch only, mirroring rewritten-engine-factory.ts's own
// withPublishGitDecorations precedent for push/commit — so the RELOCATED adapter's own argv never
// carries a credential, while every existing caller/test here observes byte-identical behavior.

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { MirrorProvisionAdapter, type MirrorProvisionDeps } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter";

// sdd/migration-wiring-phase-2 Slice 7b-2: the canonical redaction adapter (env+pattern) for this
// module's spawn-boundary error scrubbing, replacing src/util/redact.ts's redactSecrets.
const redactionPort = new RedactionPortAdapter();

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  root?: string;
}

// Exported so any other module that needs to derive a repo's mirror dir (e.g. the rewritten-engine
// factory's own vcs/mirrorDir composition) resolves it from this SINGLE source of truth, instead of
// re-deriving the same formula and silently diverging if the two definitions ever drift apart.
export function workdirRoot(): string {
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

// A branch name passed to git as a positional arg must never be parseable as an
// option (no leading '-') nor as a rev range ('..'). Same injection-closing rationale
// as assertHexSha for SHAs coming from an attacker-controlled webhook.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function assertBranchName(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

// Adapts this module's MirrorDeps (git/exists/removeFile/root, the shape every existing caller and
// test already injects) into MirrorProvisionAdapter's MirrorProvisionDeps: `root` resolves through
// the SAME workdirRoot() fallback as before, `remoteUrl` wraps tokenlessUrl (GIT_REMOTE_BASE-aware),
// and `git` is decorated to prepend authHeaderArgs() for clone/fetch ONLY — mirroring
// rewritten-engine-factory.ts's own withPublishGitDecorations precedent (push/commit there;
// clone/fetch here) — so the relocated adapter's own argv never carries a credential while the
// decorated call observed by a caller-supplied `deps.git` stays byte-identical to before this slice.
function toProvisionDeps(deps: MirrorDeps): MirrorProvisionDeps {
  return {
    root: deps.root ?? workdirRoot(),
    exists: deps.exists,
    removeFile: deps.removeFile,
    remoteUrl: tokenlessUrl,
    git: (args, cwd) => (args[0] === "clone" || args[0] === "fetch" ? deps.git([...authHeaderArgs(), ...args], cwd) : deps.git(args, cwd)),
  };
}

// Leaves the working copy PRISTINE at the SHA. `checkout -f` discards changes to
// tracked files (e.g. `e2e/` touched by a previous run that did not publish) and
// `clean -fd` removes untracked files (leftover specs), EXCEPT node_modules so
// the e2e project's deps are not reinstalled on every run. Without this, runs
// that do not publish would contaminate the next one (or break the checkout).
//
// THIN WRAPPER (migration-tier-4a) — see this module's own header for why the public signature stays
// byte-identical while the provisioning ARGV itself now lives in qa-engine's MirrorProvisionAdapter.
export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  return new MirrorProvisionAdapter(toProvisionDeps(deps)).ensureMirror(repo, sha);
}

// Pristine working copy at the HEAD of origin/<branch> (not at a specific SHA).
// Used for the PRIMARY repo of a cross-repo run: the triggering commit belongs to a
// service repo, so the front is checked out at its own base branch instead.
//
// THIN WRAPPER (migration-tier-4a) — see this module's own header; src/index.ts's onboarding job
// calls this directly, so the signature MUST stay byte-identical.
export async function ensureMirrorAtBranch(repo: string, branch: string, deps: MirrorDeps): Promise<string> {
  return new MirrorProvisionAdapter(toProvisionDeps(deps)).ensureMirrorAtBranch(repo, branch);
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

// Prepend the orchestrator's git hardening as COMMAND-LINE `-c` overrides (which a repo's own
// .git/config cannot override) before the caller's subcommand. Two concerns, both stemming from
// operating on UNTRUSTED, sandbox-touched working copies:
//   - core.hooksPath=/dev/null — a commit/checkout would otherwise run the repo's hooks AS THE
//     ORCHESTRATOR (root); a sandbox-planted `.git/hooks/pre-commit` is a root-RCE escape. The
//     orchestrator never relies on a repo's hooks, so disabling them is uniformly safe.
//   - safe.directory=* — after an e2e/code run the orchestrator chowns the working copy to the
//     unprivileged sandbox uid (to execute untrusted specs). git-as-root then aborts the NEXT
//     run's ops with "detected dubious ownership" (CVE-2022-24765 guard). These are the
//     orchestrator's own mirror dirs and hooks are already disabled above, so opting out of the
//     ownership check is safe and keeps the mirror reusable across privilege-dropped runs.
//     SCOPE CAVEAT: `*` is intentionally broad (this pure helper has no path context) and ALL git
//     callers go through here. That is acceptable because every current caller operates only on the
//     orchestrator's own mirror dirs under MIRROR_DIR with hooks disabled; a future caller for a
//     DIFFERENT context should scope this to a specific path (`safe.directory=<dir>`) instead.
export function hardenGitArgs(args: readonly string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*", ...args];
}

// A failing spawn's Error carries the FULL command line (node includes argv in err.message and
// err.cmd) — including the -c url.insteadOf config that embeds the inline token. That error
// propagates into logs (the maintainer's session-failed handler once logged a real PAT in
// plaintext), so every credential span is redacted HERE, at the spawn boundary, before the error
// can escape. Stays module-private (the spawn boundary owns it) and keeps mutating the Error in
// place — including err.cmd, which the adapter's redactError (Error-only) alone does not touch.
// sdd/migration-wiring-phase-2 Slice 7b-2: delegates to the canonical RedactionPortAdapter's
// redactText (env+pattern, src/orchestrator/sanitizer.ts) — one shared mechanism for both the
// x-access-token:...@ shape and the live token-value split, replacing src/util/redact.ts's
// redactSecrets.
function scrubGitError(err: Error & { cmd?: string }): Error {
  err.message = redactionPort.redactText(err.message);
  if (typeof err.cmd === "string") err.cmd = redactionPort.redactText(err.cmd);
  return err;
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", hardenGitArgs(args), { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
      err ? reject(scrubGitError(err)) : resolve(stdout.toString()),
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

// Slice G — PR-aware ingestion (P9 / design §P3).
//
// Compute the UNION of files changed across a PR's full commit range (`baseSha..headSha`).
// A PR can span many commits; taking only the tip commit (the current default) misses
// blast-radius files changed earlier in the branch. This union drives the Context Pack
// blast-radius construction so the generator sees ALL changed symbols, not just the latest.
//
// `baseSha` is the merge-base or the branch point; `headSha` is the PR tip. Both must be
// hex SHAs (assertHexSha — same injection-closing rationale as the rest of this module).
//
// Returns a deduplicated, sorted list of repo-relative paths. When the range is empty
// (single commit, or baseSha === headSha) the list degrades to the single-commit path
// (getCommitDiff caller extracts changed files from the raw diff) — degrade-to-n=1
// is explicit per design §2 principle 2.
//
// Webhook wiring TODO: the calling webhook handler currently derives only a single SHA
// from the push event. To use the full PR range, the webhook must resolve the PR's base
// SHA (via the GitHub API: GET /repos/{owner}/{repo}/pulls/{number}/commits, or the
// compare endpoint). Until that wiring is added, callers pass baseSha=headSha and receive
// the single-commit degenerate. The TODO is here, not silently dropped. (Slice H/I will
// resolve the webhook side once the pack is proven on the single-commit path.)
export async function getChangedFilesInRange(
  mirrorDir: string,
  baseSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<string[]> {
  assertHexSha(baseSha);
  assertHexSha(headSha);
  // When baseSha === headSha (single-commit / degenerate PR), return immediately to
  // avoid `git diff --name-only sha..sha` producing an empty output (correct, but the
  // caller already has the changed files from the commit diff).
  if (baseSha === headSha) return [];
  // --name-only lists only the file paths changed between base and head, one per line.
  const stdout = await deps.git(["diff", "--name-only", `${baseSha}..${headSha}`], mirrorDir);
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Deduplicate and sort for determinism (renames can appear twice under both paths).
  return [...new Set(files)].sort();
}

// Full unified diff across a commit RANGE (base..head) — the union of everything a PR
// introduced, not just its tip. Twin of getChangedFilesInRange, but returns the diff WITH
// line content so parseDiffHunks derives both changed files AND changed lines. Single-commit
// callers keep using getCommitDiff; this is only taken when a base SHA is known (PR/push range).
export async function getRangeDiff(
  dir: string,
  baseSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<string> {
  assertHexSha(baseSha);
  assertHexSha(headSha);
  return deps.git(["diff", `${baseSha}..${headSha}`], dir);
}

// qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts
// migration-tier-4a: owns ensureMirror/ensureMirrorAtBranch's provisioning ARGV (clone/fetch/
// checkout-f/clean, index.lock+set-url self-heal) — relocated out of
// src/integrations/repo-mirror.ts. Credentials/env (GITHUB_TOKEN via authHeaderArgs,
// GIT_REMOTE_BASE via tokenlessUrl, MIRROR_DIR via workdirRoot) stay src-side, a DECLARED
// shell-survivor (repo-mirror.ts's realGit/authHeaderArgs/tokenlessUrl/hardenGitArgs/scrubGitError)
// — this adapter never reads env or imports src/. `git`/`remoteUrl`/`root`/the fs probes are all
// injected, mirroring VcsWriteAdapter's "the real-wiring obligation is on the injector, not this
// class" precedent.
//
// repo-mirror.ts's own exported `ensureMirror`/`ensureMirrorAtBranch` now DELEGATE here (a thin
// wrapper, not a duplicate implementation) — that public signature stays byte-identical because
// src/index.ts's onboarding job calls `ensureMirrorAtBranch` directly, a SECOND production consumer
// beyond the composition factory's checkout closure that the migration design did not originally
// account for (re-verified against HEAD before this slice; see the apply report). The wrapper decorates
// its injected git fn to prepend authHeaderArgs() for clone/fetch — exactly like the factory's own
// withPublishGitDecorations wraps VcsWriteAdapter's git — so this class's own argv never mentions a
// credential.
//
// assertHexSha/assertBranchName are deliberately DUPLICATED (not imported — qa-engine may not import
// src/) from src/integrations/repo-mirror.ts, which keeps its own copies for the read-side helpers
// still living there (getCommitDiff/getCommitsBehind/getChangedFilesInRange/getRangeDiff). Same
// "duplicate pure logic across the seam" precedent as github-http.ts's clamp functions (slice 1).
import { join } from "node:path";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorProvisionDeps {
  // Already decorated with the auth-header prefix for clone/fetch by the injector — this class's own
  // argv never carries a credential flag.
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  // Built from src's tokenlessUrl (GIT_REMOTE_BASE-aware) — this class never reads env.
  remoteUrl(repo: string): string;
  // Built from src's workdirRoot() (MIRROR_DIR-aware) — this class never reads env.
  root: string;
}

// A commit SHA passed to git as a positional arg MUST be a hex id. A hex 7-40 string can never be
// parsed as a git option (e.g. `--output=...`), which closes the git-argument-injection surface from
// an attacker-controlled webhook/API sha.
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
function assertHexSha(sha: string): void {
  if (!HEX_SHA.test(sha)) throw new Error(`invalid commit sha (must be 7–40 hex chars): ${JSON.stringify(sha)}`);
}

// A branch name passed to git as a positional arg must never be parseable as an option (no leading
// '-') nor as a rev range ('..'). Same injection-closing rationale as assertHexSha.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function assertBranchName(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export class MirrorProvisionAdapter {
  constructor(private readonly deps: MirrorProvisionDeps) {}

  // Leaves the working copy PRISTINE at the SHA. `checkout -f` discards changes to tracked files
  // (e.g. `e2e/` touched by a previous run that did not publish) and `clean -fd` removes untracked
  // files (leftover specs), EXCEPT node_modules so the e2e project's deps are not reinstalled on
  // every run.
  async ensureMirror(repo: string, sha: string): Promise<string> {
    assertHexSha(sha);
    const dir = await this.syncMirror(repo);
    await this.deps.git(["checkout", "-f", sha], dir);
    await this.deps.git(["clean", "-fd", "-e", "node_modules"], dir);
    return dir;
  }

  // Pristine working copy at the HEAD of origin/<branch> (not at a specific SHA). Used for the
  // PRIMARY repo of a cross-repo run: the triggering commit belongs to a service repo, so the front
  // is checked out at its own base branch instead.
  async ensureMirrorAtBranch(repo: string, branch: string): Promise<string> {
    assertBranchName(branch);
    const dir = await this.syncMirror(repo);
    await this.deps.git(["checkout", "-f", `origin/${branch}`], dir);
    await this.deps.git(["clean", "-fd", "-e", "node_modules"], dir);
    return dir;
  }

  // Brings the mirror up to date with origin: tokenless clone when missing, fetch when present. On
  // the existing-dir path it first self-heals two failure modes: a stale `.git/index.lock` (a prior
  // abruptly-interrupted provisioning, from this or the onboarding path) and a token embedded in
  // origin's URL (mirrors cloned before the tokenless-URL policy persist the credential in
  // .git/config; `remote set-url` scrubs it on the next run).
  private async syncMirror(repo: string): Promise<string> {
    const dir = join(this.deps.root, repo.replaceAll("/", "__"));
    if (!this.deps.exists(dir)) {
      await this.deps.git(["clone", this.deps.remoteUrl(repo), dir]);
    } else {
      const indexLock = join(dir, ".git", "index.lock");
      if (this.deps.exists(indexLock)) this.deps.removeFile(indexLock);
      await this.deps.git(["remote", "set-url", "origin", this.deps.remoteUrl(repo)], dir);
      await this.deps.git(["fetch", "origin"], dir);
    }
    return dir;
  }
}

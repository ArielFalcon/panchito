import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { VcsReadPort } from "../application/ports/index.ts";

// Typed read side over a git mirror. argv lives HERE; callers pass Sha and receive typed results.
// No raw git strings, no new spawn code (consumes the kernel SandboxedBinaryRunner) and no new diff
// parser (consumes DiffParserService). Read-only: this adapter NEVER runs a git WRITE (the security
// boundary — writes live only in workspace-and-publication).
export class GitMirrorReadAdapter implements VcsReadPort {
  private readonly parser = new DiffParserService();
  constructor(private readonly repoDir: string, private readonly runner: SandboxedBinaryRunner) {}

  async diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string> {
    // Build the two discrete ref args so the adapter test can assert delegation without parsing
    // a combined range string. argv stays here; callers only pass Sha and receive typed results.
    const baseRef = opts?.baseSha ? opts.baseSha.value
      : opts?.commits ? `${sha.value}~${opts.commits}`
      : `${sha.value}^`;
    const r = await this.runner.run({
      command: "git",
      args: ["diff", "--no-color", baseRef, sha.value],
      cwd: this.repoDir,
      env: scrubEnv(),
    });
    // Surface VCS errors loudly (CLAUDE.md: "Surface integration errors loudly — never swallow").
    // A non-zero exit or timeout means the sha/repo is invalid; returning an empty string would
    // silently look like "no changed files" to every downstream consumer. Throw so the use-case
    // fail-open catch records a typed skip — a genuine VCS error must NOT become an empty diff.
    if (r.timedOut) throw new Error(`git diff timed out for ${baseRef}..${sha.value}`);
    if (r.exitCode !== 0) throw new Error(`git diff failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  async message(sha: Sha): Promise<string> {
    const r = await this.runner.run({ command: "git", args: ["log", "-1", "--format=%B", sha.value], cwd: this.repoDir, env: scrubEnv() });
    return r.stdout.trim();
  }

  async blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius> {
    const diff = await this.diff(sha, opts);
    return BlastRadius.of(sha, this.parser.changedFiles(diff));
  }
}

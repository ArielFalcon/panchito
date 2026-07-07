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

  // WS7.1 (full-flow remediation, multi-commit range restoration): every OTHER commit's message in
  // baseSha..sha, EXCLUDING sha itself (its message is fetched separately via message(sha) — see
  // this method's own port-level doc for why).
  //
  // F1 fix (adversarial review, MEDIUM — merge-commit blind spot): the range is `baseSha..sha`
  // (NOT the previous `baseSha..sha^`). `sha^` is the head's FIRST PARENT only, so a merge-commit
  // push silently dropped every commit that arrived via the merged branch (git's second-parent
  // ancestry) — empirically: `git log base..merge^` returns nothing while the merged branch had
  // real commits. `baseSha..sha` traverses BOTH parents of a merge, so a `feat:` buried in a
  // merged branch under a low-severity merge-head message now reaches classifyRange's MAX-severity
  // reduce. The full range INCLUDES the head commit itself; we drop it here by hash (never by
  // message — two commits can share a message) so "other" stays strictly non-head, matching this
  // method's own contract that head-intent comes separately from message(sha).
  // No-op (returns []) when baseSha === sha (a degenerate/empty range — nothing to enumerate).
  async otherMessages(sha: Sha, opts: { baseSha: Sha }): Promise<string[]> {
    if (opts.baseSha.value === sha.value) return [];
    // Per-commit records of `<hash>%x00<message>%x00`: the hash lets us drop the head reliably, and
    // NUL delimiters (%x00) mean a multi-line commit body can never be mistaken for a record
    // boundary (a newline-based split would corrupt a message containing blank lines).
    const r = await this.runner.run({
      command: "git",
      args: ["log", `${opts.baseSha.value}..${sha.value}`, "--format=%H%x00%B%x00"],
      cwd: this.repoDir,
      env: scrubEnv(),
    });
    if (r.timedOut) throw new Error(`git log timed out for ${opts.baseSha.value}..${sha.value}`);
    if (r.exitCode !== 0) throw new Error(`git log failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    // Split on NUL; each commit contributes two fields (hash, message). A trailing "\n" separates
    // records — trimmed off the message below.
    const fields = r.stdout.split("\0");
    const messages: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const hash = fields[i]!.replace(/^\n+/, "").trim().toLowerCase();
      const message = fields[i + 1]!.replace(/^\n+/, "").replace(/\n+$/, "");
      if (!hash) continue; // trailing empty tail after the last record's NUL
      // Drop the head commit — its message comes via message(sha). `%H` is the FULL 40-char hash but
      // sha.value may be an abbreviation (Sha accepts 4-40 chars), so match by prefix, never exact
      // equality (an abbreviated head would otherwise never match its own full hash and leak in).
      if (hash.startsWith(sha.value)) continue;
      if (message.length > 0) messages.push(message);
    }
    return messages;
  }
}

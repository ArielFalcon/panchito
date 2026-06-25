// qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts
// The ONLY context that holds VcsWritePort — the security seam made structural (§2 G3). The arch-lint
// gate (Task 12) forbids any generation/* or agent-runtime/* module from importing VcsWritePort or a
// write adapter. WorkspaceVcsReadPort is the safe workspace read side (diff/status — distinct from
// change-analysis VcsReadPort which owns diff/message/blastRadius). RedactionPort is consumed FROM
// the kernel (egress sanitization), not redefined here. Interfaces only — no GitWriteAdapter.

import type { Sha } from "@kernel/sha.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

// Named WorkspaceVcsReadPort (not VcsReadPort) to avoid a name collision with change-analysis's
// VcsReadPort — both are named "VcsRead" but have irreconcilable method sets. This context's read
// side covers workspace status (diff/status); change-analysis covers commit analysis (diff/message/blastRadius).
export interface WorkspaceVcsReadPort {
  diff(sha: Sha): Promise<string>;
  status(dir: string): Promise<string>;
}
// [SWAP — orchestrator-only; the security seam]. Only this context's adapters implement it.
export interface VcsWritePort {
  commit(dir: string, message: string, files: readonly string[]): Promise<void>;
  push(dir: string, branch: string): Promise<void>;
}
export interface PullRequest { url: string; number: number; }
export interface Issue { url: string; number: number; }
// [SWAP — typed, not raw fetch].
export interface GitHubPrPort {
  openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest>;
}
export interface GitHubIssuePort {
  open(repo: string, title: string, body: string): Promise<Issue>;
}
export interface MirrorGcPort {
  prune(repo: string): Promise<void>;
}
export interface PublishDecision { verdict: RunVerdict; outcome: string; }
export interface ConfinementResult { strays: number; dangerous: number; reverted: string[]; }

// qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts
// The ONLY context that holds VcsWritePort — the security seam made structural (§2 G3). The arch-lint
// gate (Task 12) forbids any generation/* or agent-runtime/* module from importing VcsWritePort or a
// write adapter. RedactionPort is consumed FROM the kernel (egress sanitization), not redefined here.
// Interfaces only — no GitWriteAdapter.

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
// The shadow-mode swap boundary. ShadowLogAdapter implements this port; at composition
// time (Plan 6) the DI container selects ShadowLogAdapter when qa.shadow=true and the
// real adapters otherwise. This named interface makes the arch-lint capable of forbidding
// shadow-mode from leaking into the generation context.
export interface ShadowPublicationPort {
  openPr(repo: string, branch: string, title: string, body: string): Promise<void>;
  openIssue(repo: string, title: string, body: string): Promise<void>;
  commit(dir: string, message: string, files: readonly string[]): Promise<void>;
  push(dir: string, branch: string): Promise<void>;
  prune(mirrorDir: string): Promise<void>;
}
// Re-export the domain's canonical PublishDecision and its companions so Plan-6 consumers
// can import from the ports barrel rather than reaching into the domain layer directly.
export type { PublishDecision, PublishOutcome, PublishContext } from "../../domain/publish-decision.service.ts";

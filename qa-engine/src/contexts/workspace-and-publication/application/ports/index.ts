// qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts
// The ONLY context that holds VcsWritePort — the security seam made structural (§2 G3). The arch-lint
// gate (Task 12) forbids any generation/* or agent-runtime/* module from importing VcsWritePort or a
// write adapter. RedactionPort is consumed FROM the kernel (egress sanitization), not redefined here.
// Interfaces only — no GitWriteAdapter.

// [SWAP — orchestrator-only; the security seam]. Only this context's adapters implement it.
//
// PROD-BLOCKER fix: widened with the remaining legacy git-mechanics primitives (src/integrations/
// publish.ts's publishChanges — checkout -B, status-check/skip-if-no-changes, local-exclude write)
// so this port is the COMPLETE git side of publish. Previously only commit/push existed and this
// port's sole implementation (VcsWriteAdapter) was never instantiated anywhere outside its own
// test — the rewritten publish path called straight into GitHubPrAdapter.openWithAutoMerge() with
// no branch ever created/pushed. checkoutBranch/hasChanges/writeExcludes close that gap.
export interface VcsWritePort {
  // sdd/security-hardening Slice 1: the OPTIONAL 4th arg is a SECOND, independent, deterministic
  // guard against a modified-TRACKED denylisted path (Dockerfile, .github/workflows/*, …) reaching
  // the commit — gitignore-style excludes (writeExcludes/.git/info/exclude) only suppress UNTRACKED
  // paths, so a code-target run (`files` = ["."], the whole tree) staging a real, already-tracked
  // Dockerfile that an agent tampered with is otherwise invisible to the exclude list. This check is
  // deliberately independent of the runtime WriteConfinementAdapter.enforce() step (RunQaUseCase
  // wraps that call in a documented fail-open try/catch, D-P0b) — a modified-tracked stray must never
  // reach a commit even when confinement never ran or itself threw.
  //
  // judgment-day round 2 (FIX 3, HIGH): the return value carries `revertedDenylisted` (always an
  // array, never undefined) so a reverted tamper is never silent — the caller threads it into the
  // SAME gateSignals.confinement accumulator ConfinementPort.enforce() already feeds, and the
  // adapter itself ALSO logs loudly at the moment of revert (defense in depth: a trace exists even
  // if some future caller forgets to read the return value).
  //
  // judgment-day round 3 (FIX E, both judges): `revertedDangerous` (also always an array) is the
  // SUBSET of revertedDenylisted that matches WriteConfinementService.isDangerousPath's narrower
  // secret tier (.env/.env.*/*.env, or a symlink escape) — the SAME predicate
  // WriteConfinementAdapter.enforce() already uses to decide its own `dangerous` count. Computed
  // HERE (the adapter has direct access to WriteConfinementService), not re-derived by a caller that
  // cannot import this context's domain — a caller must never conflate "reverted" with "dangerous"
  // again by re-implementing the secret-tier check itself.
  commit(dir: string, message: string, files: readonly string[], denyModifiedTracked?: (path: string) => boolean): Promise<{ revertedDenylisted: string[]; revertedDangerous: string[] }>;
  push(dir: string, branch: string): Promise<void>;
  // git checkout -B <branch> — (re)creates the publish branch at the mirror's current HEAD.
  checkoutBranch(dir: string, branch: string): Promise<void>;
  // `git status --porcelain -- <pathspecs>` non-empty -> true. Scoped to the exact pathspecs (never
  // the whole repo) so an unrelated dirty file elsewhere in the mirror never triggers a publish.
  hasChanges(dir: string, pathspecs: readonly string[]): Promise<boolean>;
  // Writes gitignore-style patterns to .git/info/exclude (LOCAL, never committed) so `git add` on a
  // directory pathspec silently skips installed deps/artifacts instead of failing on an ignored path.
  writeExcludes(dir: string, patterns: readonly string[]): Promise<void>;
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

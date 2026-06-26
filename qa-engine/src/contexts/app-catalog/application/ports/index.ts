// qa-engine/src/contexts/app-catalog/application/ports/index.ts
// Watched-app config + cross-repo routing ports. AppRepositoryPort [SWAP] loads/validates app config;
// RepoInfoPort talks to GitHub for repo metadata. App-specificity lives ONLY here (CLAUDE.md invariant).
// The App aggregate + RepoResolutionService are domain (Plan 4); these are the driven seams.

export interface ServiceConfig { repo: string; openapi?: string; versionUrl?: string; }
export type RepoRole = "primary" | "service";
export interface AppConfigSnapshot {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean; services: ServiceConfig[];
}
// [SWAP] — yaml today, swappable behind the port.
export interface AppRepositoryPort {
  load(name: string): Promise<AppConfigSnapshot>;
  list(): Promise<AppConfigSnapshot[]>;
  // EVERY app the repo participates in — a repo can be primary of one app AND service of another,
  // so the result is an array (the webhook enqueues one run per match). Empty when unwatched.
  resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole }[]>;
}
export interface RepoInfoPort {
  defaultBranch(repoSlug: string): Promise<string>;
}

// src/contexts/app-catalog/domain/repo-resolution.service.ts
// Resolves a repo slug to EVERY owning App + its role (primary vs service) for cross-repo
// microservice triggers. Pure — over App aggregates, not the filesystem. A repo can be the
// primary of one app AND a service of another (its own code-mode app + the front's e2e app),
// so the result is an array — one entry per match (the webhook enqueues one run per match).
// An unknown slug (the webhook is for an unwatched repo) yields an empty array — never throws.
import type { App } from "./app.aggregate.ts";
import type { RepoRole } from "../application/ports/index.ts";

export interface RepoResolution { app: App; role: RepoRole; }

export class RepoResolutionService {
  constructor(private readonly apps: readonly App[]) {}
  resolve(repoSlug: string): RepoResolution[] {
    const matches: RepoResolution[] = [];
    for (const app of this.apps) {
      if (app.primaryRepo === repoSlug) matches.push({ app, role: "primary" });
      else if (app.serviceRepos.includes(repoSlug)) matches.push({ app, role: "service" });
    }
    return matches;
  }
}

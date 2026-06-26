// src/contexts/app-catalog/domain/repo-resolution.service.ts
// Resolves a repo slug to the owning App + its role (primary vs service) for cross-repo
// microservice triggers. Pure — over App aggregates, not the filesystem. Returns null for an
// unknown slug (the webhook is for an unwatched repo) — never throws.
import type { App } from "./app.aggregate.ts";

export type RepoRole = "primary" | "service";
export interface RepoResolution { app: App; role: RepoRole; }

export class RepoResolutionService {
  constructor(private readonly apps: readonly App[]) {}
  resolve(repoSlug: string): RepoResolution | null {
    for (const app of this.apps) {
      if (app.primaryRepo === repoSlug) return { app, role: "primary" };
      if (app.serviceRepos.includes(repoSlug)) return { app, role: "service" };
    }
    return null;
  }
}

// src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts
// WRAP of src/orchestrator/config-loader.ts. Delegates to the injected loadAppConfig/listAppConfigs
// (so the adapter test needs no config/ files), validates via the App aggregate, and projects to the
// port's AppConfigSnapshot. App-specificity stays HERE.
import type { AppRepositoryPort, AppConfigSnapshot, RepoRole } from "../application/ports/index.ts";
import { App } from "../domain/app.aggregate.ts";
import { RepoResolutionService } from "../domain/repo-resolution.service.ts";

// Structural shape of the legacy ValidatedAppConfig fields this adapter reads (declared locally so
// the adapter does not import from src/; the real loaders are injected at wiring time).
interface LegacyConfig {
  name: string; repo: string; baseBranch?: string; code?: boolean;
  qa?: { shadow?: boolean }; services?: { repo: string; openapi?: string; versionUrl?: string }[];
  dev?: { versionUrl?: string };
}
export interface ConfigLoaders {
  load(name: string): LegacyConfig;
  list(): LegacyConfig[];
}

function toSnapshot(cfg: LegacyConfig): AppConfigSnapshot {
  const app = App.fromConfig({
    name: cfg.name, repo: cfg.repo, baseBranch: cfg.baseBranch ?? "main",
    code: cfg.code ?? false, shadow: cfg.qa?.shadow ?? false,
    services: cfg.services ?? [],
    dev: cfg.dev,
  });
  return {
    name: app.name, repo: app.primaryRepo, baseBranch: app.baseBranch,
    code: app.isCode, shadow: app.isShadow,
    services: (cfg.services ?? []).map((s) => ({ repo: s.repo, ...(s.openapi ? { openapi: s.openapi } : {}), ...(s.versionUrl ? { versionUrl: s.versionUrl } : {}) })),
  };
}

export class YamlAppConfigAdapter implements AppRepositoryPort {
  constructor(private readonly loaders: ConfigLoaders) {}

  async load(name: string): Promise<AppConfigSnapshot> {
    return toSnapshot(this.loaders.load(name));
  }

  async list(): Promise<AppConfigSnapshot[]> {
    return this.loaders.list().map(toSnapshot);
  }

  async resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole }[]> {
    // Call list() ONCE into a local const to avoid the double FS scan and the non-null-assertion
    // race where the second list() call could return a different set (e.g. a file was added between
    // the two calls, or the loader is a test double that mutates state).
    const configs = this.loaders.list();
    const apps = configs.map((c) => App.fromConfig({
      name: c.name, repo: c.repo, baseBranch: c.baseBranch ?? "main",
      code: c.code ?? false, shadow: c.qa?.shadow ?? false, services: c.services ?? [], dev: c.dev,
    }));
    // EVERY match — a repo that is primary of one app AND service of another fans out to BOTH
    // (mirrors legacy loadAppConfigsByRepo). Find each cfg from the same local const — no second
    // FS scan, no race.
    return new RepoResolutionService(apps).resolve(repoSlug).map((resolution) => {
      const cfg = configs.find((c) => c.name === resolution.app.name)!;
      return { app: toSnapshot(cfg), role: resolution.role };
    });
  }
}

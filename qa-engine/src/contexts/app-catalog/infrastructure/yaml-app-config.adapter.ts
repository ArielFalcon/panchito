// src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts
// WRAP of src/orchestrator/config-loader.ts. Delegates to the injected loadAppConfig/listAppConfigs
// (so the adapter test needs no config/ files), validates via the App aggregate, and projects to the
// port's AppConfigSnapshot. App-specificity stays HERE.
import type { AppRepositoryPort, AppConfigSnapshot, RepoRole } from "../application/ports/index.ts";
import { App } from "../domain/app.aggregate.ts";
import { RepoResolutionService } from "../domain/repo-resolution.service.ts";

// Structural shape of the legacy ValidatedAppConfig fields this adapter reads (declared locally so
// the adapter does not import from src/; the real loaders are injected at wiring time). services[].
// openapi mirrors AppConfigSchema (src/orchestrator/schemas.ts) exactly — a service may declare
// either one glob or several — widened (sdd/migration-wiring-phase-2 Slice 1, task 1.2) so the real
// loadAppConfig/listAppConfigs shell loaders (ValidatedAppConfig) satisfy this shape structurally.
interface LegacyConfig {
  name: string; repo: string; baseBranch?: string; code?: boolean;
  qa?: { shadow?: boolean }; services?: { repo: string; openapi?: string | string[]; versionUrl?: string }[];
  dev?: { versionUrl?: string };
}
export interface ConfigLoaders {
  load(name: string): LegacyConfig;
  list(): LegacyConfig[];
}

// judgment-day fix: injected so this adapter never imports from src/ (qa-engine/src stays
// independent of the shell) — mirrors config-loader.ts's own logConfigSkip posture (skip-and-log,
// never fatal), one layer up: config-loader.ts's listAppConfigs already isolates the shell's zod
// schema layer per-FILE; this callback lets resolveByRepo isolate App.fromConfig's own aggregate
// invariants per-CONFIG (see resolveByRepo's own header for why the two layers can diverge).
export type ConfigSkipLogger = (name: string, err: unknown) => void;

const defaultConfigSkipLogger: ConfigSkipLogger = (name, err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[qa] skipping app config "${name}" — failed aggregate validation: ${msg}`);
};

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
  constructor(
    private readonly loaders: ConfigLoaders,
    private readonly onConfigSkip: ConfigSkipLogger = defaultConfigSkipLogger,
  ) {}

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
    // judgment-day fix: per-config fault isolation. A config that already passed the shell's zod
    // schema (config-loader.ts's own listAppConfigs isolates THAT layer, per-FILE) can still fail
    // App.fromConfig's OWN aggregate invariants — app.aggregate.ts's RIDER 3 explicitly documents
    // these can drift from the zod refine rules, and this adapter's own `loaders` is an injected
    // interface with no compiler guarantee every implementation routes through zod at all. Before
    // this fix, `.map()` threw on the FIRST such config and resolveByRepo — hence the webhook
    // dispatch for EVERY app sharing this catalog — failed outright. Mirrors config-loader.ts's own
    // skip-and-log posture, one layer up: the offending config is skipped (via the injected
    // onConfigSkip, defaulting to a qa-engine-local console.warn), never blocking the rest.
    const apps: App[] = [];
    for (const c of configs) {
      try {
        apps.push(App.fromConfig({
          name: c.name, repo: c.repo, baseBranch: c.baseBranch ?? "main",
          code: c.code ?? false, shadow: c.qa?.shadow ?? false, services: c.services ?? [], dev: c.dev,
        }));
      } catch (err) {
        this.onConfigSkip(c.name, err);
      }
    }
    // EVERY match — a repo that is primary of one app AND service of another fans out to BOTH
    // (mirrors legacy loadAppConfigsByRepo). Find each cfg from the same local const — no second
    // FS scan, no race.
    return new RepoResolutionService(apps).resolve(repoSlug).map((resolution) => {
      const cfg = configs.find((c) => c.name === resolution.app.name)!;
      return { app: toSnapshot(cfg), role: resolution.role };
    });
  }
}

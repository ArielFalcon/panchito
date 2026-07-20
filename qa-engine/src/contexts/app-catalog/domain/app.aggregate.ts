// src/contexts/app-catalog/domain/app.aggregate.ts
// The App aggregate: the watched-app config invariants (today the zod AppConfigSchema refinements)
// expressed as DOMAIN RULES, so the engine depends on a validated aggregate, not a raw config.
// App-specificity lives ONLY in this context (CLAUDE.md invariant).
// openapi mirrors the shell's real AppConfigSchema (src/orchestrator/schemas.ts): a service may
// declare either one glob or several — widened here (sdd/migration-wiring-phase-2 Slice 1, task
// 1.2) so the real loadAppConfig/listAppConfigs shell loaders type-check against this shape once
// actually wired; the narrower `string`-only declaration was never exercised before this change
// (this context had zero production callers until this slice).
export interface AppServiceConfig { repo: string; openapi?: string | string[]; versionUrl?: string; }
export interface AppConfigInput {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean;
  services: AppServiceConfig[];
  dev?: { versionUrl?: string } | undefined;
}

export class App {
  private constructor(private readonly cfg: AppConfigInput) {}

  static fromConfig(cfg: AppConfigInput): App {
    // RIDER 3 (sdd/migration-wiring-phase-2 Slice 1, D-A drift-risk note): Invariant 1 and
    // Invariant 2 below are duplicated, word-for-word equivalent, in the shell's zod
    // AppConfigSchema.refine rules (src/orchestrator/schemas.ts) — this context's own domain
    // aggregate re-validates the SAME two rules over the config projection it receives from
    // YamlAppConfigAdapter. Today they cannot silently diverge because both are hand-maintained
    // against the same shipped config shape, but there is no compiler/test tie between them — if
    // you change either invariant here, update the matching zod refine (and vice versa), or the two
    // validators will drift.
    // Invariant 1: dev required unless code mode (code apps have no web environment).
    if (!cfg.code && cfg.dev === undefined) {
      throw new Error("dev is required unless code: true (code mode has no web environment)");
    }
    // Invariant 2: services are e2e-only.
    if (cfg.code && cfg.services.length > 0) {
      throw new Error("services are only valid for e2e apps (code-mode apps have no E2E suite)");
    }
    // Invariant 3a: no service repo may equal the primary repo.
    const serviceRepoSet = cfg.services.map((s) => s.repo);
    if (serviceRepoSet.includes(cfg.repo)) {
      throw new Error(`service repo "${cfg.repo}" must not equal the primary repo (circular dependency)`);
    }
    // Invariant 3b: service repos must be unique among themselves.
    if (new Set(serviceRepoSet).size !== serviceRepoSet.length) {
      throw new Error("service repos must be unique — duplicate service repo found");
    }
    return new App(cfg);
  }

  get name(): string { return this.cfg.name; }
  get primaryRepo(): string { return this.cfg.repo; }
  get baseBranch(): string { return this.cfg.baseBranch; }
  get isCode(): boolean { return this.cfg.code; }
  get isShadow(): boolean { return this.cfg.shadow; }
  get serviceRepos(): string[] { return this.cfg.services.map((s) => s.repo); }
}

// Server-side app onboarding/deletion. EVERYTHING that needs secrets or writes
// config runs here (the orchestrator has the tokens; the TUI does not — that was
// the root cause of the broken wizard). All side effects are injected (AppAdminDeps)
// so the logic is unit-tested with stubs.

import { parse } from "yaml";
import { AppConfigSchema } from "../orchestrator/schemas";
import { expandEnv, type AppConfig } from "../orchestrator/config-loader";
import { buildYaml, suggestName, type OnboardInput, type OnboardServiceInput } from "./onboard";
import type { RepoInfo } from "../integrations/github";
import type { TestTarget } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AppAdminDeps {
  getRepoInfo(repo: string): Promise<RepoInfo>;
  configExists(name: string): boolean;
  writeConfig(name: string, yaml: string): string;
  deleteConfig(name: string): void;
  deleteMirror(repo: string): void;
  deleteHistory(app: string): number;
  applyEnv(vars: Record<string, string>): string[];
  loadApp(name: string): AppConfig;
  env: Record<string, string | undefined>;
}

export interface CreateAppInput {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  dryRun?: boolean;
  validateOnly?: boolean;
}

export interface UpdateAppInput {
  name: string;
  repo?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  dryRun?: boolean;
}

export interface CreateAppResult {
  ok: boolean;
  errors?: string[];
  repoInfo?: RepoInfo;
  yaml?: string;
  name?: string;
  path?: string;
  envApplied?: string[];
  warnings?: string[];
}

export async function createApp(input: CreateAppInput, deps: AppAdminDeps): Promise<CreateAppResult> {
  let repoInfo: RepoInfo;
  try {
    repoInfo = await deps.getRepoInfo(input.repo);
  } catch (err) {
    return { ok: false, errors: [`repo validation failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (input.validateOnly) return { ok: true, repoInfo };

  const name = input.name ?? suggestName(input.repo);
  if (!NAME_RE.test(name)) return { ok: false, errors: [`invalid app name '${name}' (expected [a-z0-9][a-z0-9-]*)`] };
  if (!input.dryRun && deps.configExists(name)) return { ok: false, errors: [`app '${name}' already exists`] };

  const onboard: OnboardInput = {
    name,
    repo: repoInfo.fullName,
    baseBranch: repoInfo.defaultBranch,
    baseUrl: input.baseUrl || `https://github.com/${repoInfo.fullName}`,
    versionUrl: input.versionUrl || undefined,
    target: input.target ?? "e2e",
    needsReview: input.needsReview ?? true,
    shadow: input.shadow ?? true,
    testDataPrefix: input.testDataPrefix || "qa-bot",
    services: input.services,
  };
  const yaml = buildYaml(onboard);

  // Validate what loadAppConfig will see: env-expanded YAML against the schema. For a
  // dryRun, expansion uses the PROVIDED env over the live one without applying anything.
  const expansionEnv = { ...deps.env, ...(input.env ?? {}) };
  try {
    AppConfigSchema.parse(parse(expandEnv(yaml, expansionEnv)));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], yaml };
  }

  if (input.dryRun) return { ok: true, repoInfo, name, yaml };

  let envApplied: string[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    envApplied = deps.applyEnv(input.env);
  }
  const path = deps.writeConfig(name, yaml);
  const warnings = envApplied.length
    ? ["env vars persisted to .env and applied live — if you deploy with Doppler, add them in Doppler too or they die with the container"]
    : [];
  return { ok: true, repoInfo, name, path, envApplied, warnings };
}

export async function updateApp(input: UpdateAppInput, deps: AppAdminDeps): Promise<CreateAppResult> {
  let existing: AppConfig;
  try {
    existing = deps.loadApp(input.name);
  } catch (err) {
    return { ok: false, errors: [`app '${input.name}' not found`] };
  }

  const repo = input.repo ?? existing.repo;
  let repoInfo: RepoInfo | undefined;
  if (repo !== existing.repo) {
    try {
      repoInfo = await deps.getRepoInfo(repo);
    } catch (err) {
      return { ok: false, errors: [`repo validation failed: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  const target = input.target ?? (existing.code ? "code" : "e2e");
  const onboard: OnboardInput = {
    name: input.name,
    repo: repoInfo?.fullName ?? repo,
    baseBranch: repoInfo?.defaultBranch ?? existing.baseBranch ?? "main",
    baseUrl: input.baseUrl ?? existing.dev?.baseUrl ?? `https://github.com/${repo}`,
    versionUrl: input.versionUrl ?? existing.dev?.versionUrl ?? undefined,
    target,
    needsReview: input.needsReview ?? existing.qa.needsReview,
    shadow: input.shadow ?? existing.qa.shadow ?? true,
    testDataPrefix: input.testDataPrefix ?? existing.qa.testDataPrefix ?? "qa-bot",
    services: input.services ?? existing.services?.map((s) => ({
      repo: s.repo,
      openapi: Array.isArray(s.openapi) ? s.openapi[0] : s.openapi,
      versionUrl: s.versionUrl,
    })),
  };

  const yaml = buildYaml(onboard);

  const expansionEnv = { ...deps.env, ...(input.env ?? {}) };
  try {
    AppConfigSchema.parse(parse(expandEnv(yaml, expansionEnv)));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], yaml };
  }

  if (input.dryRun) return { ok: true, repoInfo, name: input.name, yaml };

  let envApplied: string[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    envApplied = deps.applyEnv(input.env);
  }
  const path = deps.writeConfig(input.name, yaml);
  const warnings = envApplied.length
    ? ["env vars persisted to .env and applied live — if you deploy with Doppler, add them in Doppler too or they die with the container"]
    : [];
  return { ok: true, repoInfo, name: input.name, path, envApplied, warnings };
}

export function deleteApp(name: string, purge: boolean, deps: AppAdminDeps): { removed: string[] } {
  if (!NAME_RE.test(name)) throw new Error(`invalid app name: ${JSON.stringify(name)}`);
  const app = deps.loadApp(name); // throws if not onboarded
  const removed: string[] = [];
  deps.deleteConfig(name);
  removed.push(`config:${name}`);
  if (purge) {
    // ONLY the primary mirror: a service repo's mirror may be shared with another app,
    // and mirrors are regenerable caches anyway.
    deps.deleteMirror(app.repo);
    removed.push(`mirror:${app.repo}`);
    deps.deleteHistory(name);
    removed.push(`history:${name}`);
  }
  return { removed };
}

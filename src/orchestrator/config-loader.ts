// Loads and validates the configuration of a watched app. All app-specific
// detail lives here (config/), never in the code. ${VARS} in the YAML are
// expanded from the environment, so credentials never live in the repo.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AppConfigSchema, type ValidatedAppConfig } from "./schemas";

const ROOT = process.env.AI_PIPELINE_ROOT ?? process.cwd();

export interface AppConfig extends ValidatedAppConfig {}

export function loadAppConfig(name: string, root = ROOT): ValidatedAppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`config/apps/${name}.yaml not found — is the app onboarded?`);
  }
  const raw = expandEnv(readFileSync(path, "utf8"));
  return AppConfigSchema.parse(parse(raw));
}

export type RepoRole = "primary" | "service";

export interface RepoMatch {
  app: AppConfig;
  role: RepoRole;
}

// Resolves EVERY app the event's repo participates in. A repo can be the primary
// of one app AND a service of another (its own code-mode app + the front's e2e app):
// the webhook enqueues one run per match. A malformed YAML is skipped (and logged),
// never hiding the other apps.
export function loadAppConfigsByRepo(repo: string, root = ROOT): RepoMatch[] {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return [];
  const out: RepoMatch[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") || file.startsWith("example")) continue;
    let cfg: AppConfig;
    try {
      cfg = loadAppConfig(file.replace(/\.yaml$/, ""), root);
    } catch (err) {
      console.warn(`[qa] skipping malformed config ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (cfg.repo === repo) out.push({ app: cfg, role: "primary" });
    else if (cfg.services?.some((s) => s.repo === repo)) out.push({ app: cfg, role: "service" });
  }
  return out;
}

// Returns all configured apps (name, repo, baseUrl). A single malformed YAML
// is skipped (and logged), never hiding every other app.
export function listAppConfigs(root = ROOT): AppConfig[] {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return [];
  const out: AppConfig[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") || f.startsWith("example")) continue;
    try {
      out.push(loadAppConfig(f.replace(/\.yaml$/, ""), root));
    } catch (err) {
      console.warn(`[qa] skipping malformed config ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}

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

// Resolves the config from the event's repo (the webhook carries repo + sha).
export function loadAppConfigByRepo(repo: string, root = ROOT): AppConfig | null {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml")) continue;
    const cfg = loadAppConfig(file.replace(/\.yaml$/, ""), root);
    if (cfg.repo === repo) return cfg;
  }
  return null;
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

function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
}

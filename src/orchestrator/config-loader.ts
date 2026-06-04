// Loads and validates the configuration of a watched app. All app-specific
// detail lives here (config/), never in the code. ${VARS} in the YAML are
// expanded from the environment, so credentials never live in the repo.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.env.AI_PIPELINE_ROOT ?? process.cwd();

export interface AppConfig {
  name: string;
  repo: string;
  baseBranch?: string; // target branch for the QA pull requests (defaults to "main")
  dev: {
    baseUrl: string;
    versionUrl: string;
    pollIntervalMs: number;
    deployTimeoutMs: number;
  };
  qa: {
    needsReview: boolean;
    testDataPrefix: string;
    shadow?: boolean; // shadow mode: run everything but do NOT publish PRs or open Issues
  };
  report: { onFailure: string };
}

export function loadAppConfig(name: string, root = ROOT): AppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`config/apps/${name}.yaml not found — is the app onboarded?`);
  }
  const raw = expandEnv(readFileSync(path, "utf8"));
  return parse(raw) as AppConfig;
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

function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
}

// Loads and validates the configuration of a watched app. All app-specific
// detail lives here (config/), never in the code. ${VARS} in the YAML are
// expanded from the environment, so credentials never live in the repo.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AppConfigSchema, type ValidatedAppConfig } from "./schemas";

const ROOT = process.env.PANCHITO_ROOT ?? process.cwd();

export interface AppConfig extends ValidatedAppConfig {}

export function loadAppConfig(name: string, root = ROOT): ValidatedAppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`config/apps/${name}.yaml not found — is the app onboarded?`);
  }
  const raw = expandEnv(readFileSync(path, "utf8"));
  return AppConfigSchema.parse(parse(raw));
}

// An unset ${VAR} is an OPERATOR error that silently un-watches an app (no webhooks for it),
// which reads very differently from a genuinely malformed YAML — surface it as an ERROR so it
// is not lost in the noise.
function logConfigSkip(file: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unset env var/.test(msg)) {
    console.error(
      `[qa] CONFIG ERROR: ${file} references an unset env var — this app will NOT be watched ` +
        `(no webhooks processed for it) until the variable is set in the environment: ${msg}`,
    );
  } else {
    console.warn(`[qa] skipping malformed config ${file}: ${msg}`);
  }
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
      logConfigSkip(file, err);
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
      logConfigSkip(f, err);
    }
  }
  return out;
}

export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  // Match any valid shell-style identifier (NOT uppercase-only): a mis-cased ${myToken}
  // previously slipped through the uppercase regex unexpanded and reached the parser as the
  // literal string "${myToken}" — a silently broken config instead of a clear "unset" error.
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}

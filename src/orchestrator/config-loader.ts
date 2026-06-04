// Carga y valida la configuración específica de la app vigilada. Toda la
// especificidad vive aquí (config/), nunca en el código. Los ${VARS} en el
// YAML se expanden desde el entorno: las credenciales no viven en el repo.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.env.AI_PIPELINE_ROOT ?? process.cwd();

export interface AppConfig {
  name: string;
  repo: string;
  dev: {
    baseUrl: string;
    versionUrl: string;
    pollIntervalMs: number;
    deployTimeoutMs: number;
  };
  qa: {
    needsReview: boolean;
    testDataPrefix: string;
    criticalFlows: string[];
    credentials?: Record<string, string>;
  };
  report: { onFailure: string };
}

export function loadAppConfig(name: string, root = ROOT): AppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`No existe config/apps/${name}.yaml — ¿acoplaste la app?`);
  }
  const raw = expandEnv(readFileSync(path, "utf8"));
  return parse(raw) as AppConfig;
}

export function loadAiIgnore(root = ROOT): string[] {
  const path = join(root, "config", "context", ".aiignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function loadSystemPrompt(role: string, root = ROOT): string {
  const base = readMaybe(join(root, "config", "prompts", "system", "base.md"));
  const rolePrompt = readMaybe(join(root, "config", "prompts", "system", `${role}.md`));
  return [base, rolePrompt].filter(Boolean).join("\n\n");
}

function readMaybe(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
}

// Pure onboarding logic: YAML generation and config file writing. Testable without Ink.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TestTarget } from "../types";

export interface OnboardServiceInput {
  repo: string;
  openapi?: string;
  versionUrl?: string;
}

export interface OnboardInput {
  name: string;
  repo: string;
  baseBranch: string;
  baseUrl: string;
  versionUrl?: string;
  target: TestTarget;
  needsReview: boolean;
  shadow: boolean;
  testDataPrefix: string;
  services?: OnboardServiceInput[];
}

export function buildYaml(input: OnboardInput): string {
  const lines: string[] = [
    `name: "${input.name}"`,
    `repo: "${input.repo}"`,
    `baseBranch: "${input.baseBranch}"`,
  ];

  if (input.target === "code") {
    lines.push("", "code: true");
  }

  lines.push(
    "",
    "dev:",
    `  baseUrl: "${input.baseUrl}"`,
    ...(input.target === "code"
      ? [`  # code mode — no web UI, but the config structure requires it`]
      : []),
  );

  if (input.versionUrl && input.target !== "code") {
    lines.push(`  versionUrl: "${input.versionUrl}"`);
  }

  if (input.target !== "code" && input.services?.length) {
    lines.push("", "services:");
    for (const s of input.services) {
      lines.push(`  - repo: "${s.repo}"`);
      if (s.openapi) lines.push(`    openapi: "${s.openapi}"`);
      if (s.versionUrl) lines.push(`    versionUrl: "${s.versionUrl}"`);
    }
  }

  lines.push(
    "",
    "qa:",
    `  needsReview: ${input.needsReview}`,
    `  shadow: ${input.shadow}`,
    `  testDataPrefix: "${input.testDataPrefix}"`,
    "",
    "report:",
    `  onFailure: "github-issue"`,
    "",
  );

  return lines.join("\n");
}

export function writeConfig(name: string, yaml: string, root = process.cwd()): string {
  const dir = join(root, "config", "apps");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, yaml, "utf8");
  return path;
}

export function configExists(name: string, root = process.cwd()): boolean {
  return existsSync(join(root, "config", "apps", `${name}.yaml`));
}

export function suggestName(repo: string): string {
  const parts = repo.split("/");
  return (parts[1] ?? parts[0] ?? "app").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// Prepares the repo's `e2e/` project to run the harness, BEFORE Filters B/C:
//   1. Bootstrap: if the repo has no `e2e/` project yet (first time), copy the
//      SEED (config/e2e: base Playwright config, fixtures, lint, tsconfig). That
//      scaffold lands in the first PR → from then on the repo owns it.
//   2. Install: install the e2e project's dependencies.
// Disk/process operations are injected, so the logic is verifiable; the real
// copy / `npm ci` are the boundary not covered by unit tests.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "./code-runner";

export interface SetupDeps {
  hasProject(e2eDir: string): boolean; // does the e2e project already exist?
  bootstrap(e2eDir: string): void; // copy the seed into the repo
  install(e2eDir: string): Promise<void>;
}

export async function setupE2eProject(e2eDir: string, deps: SetupDeps): Promise<void> {
  if (!deps.hasProject(e2eDir)) deps.bootstrap(e2eDir); // first time: seed it
  if (isInstallCurrent(e2eDir)) return;
  await deps.install(e2eDir);
  markInstallCurrent(e2eDir);
}

// ── install caching ─────────────────────────────────────────────────────────
// ensureMirror preserves node_modules across runs (git clean -e node_modules),
// but npm ci unconditionally removes and reinstalls them. We skip the install
// when node_modules exists and the lockfile hasn't changed since the last
// successful install — the same intent the -e flag already expresses.
function getLockHash(e2eDir: string): string | null {
  const lockPath = join(e2eDir, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  return createHash("sha256").update(readFileSync(lockPath)).digest("hex");
}

function isInstallCurrent(e2eDir: string): boolean {
  const nodeModules = join(e2eDir, "node_modules");
  const markerPath = join(nodeModules, ".install-hash");
  if (!existsSync(nodeModules) || !existsSync(markerPath)) return false;
  const currentHash = getLockHash(e2eDir);
  if (!currentHash) return false;
  try {
    return readFileSync(markerPath, "utf8").trim() === currentHash;
  } catch {
    return false;
  }
}

function markInstallCurrent(e2eDir: string): void {
  const hash = getLockHash(e2eDir);
  if (!hash) return;
  mkdirSync(join(e2eDir, "node_modules"), { recursive: true });
  writeFileSync(join(e2eDir, "node_modules", ".install-hash"), hash);
}

function seedDir(): string {
  return join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "config", "e2e");
}

export const defaultSetupDeps: SetupDeps = {
  hasProject: (e2eDir) => existsSync(join(e2eDir, "package.json")),
  bootstrap: (e2eDir) =>
    cpSync(seedDir(), e2eDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    }),
  install: (e2eDir) =>
    new Promise((resolve, reject) => {
      // `npm ci` when there is a lockfile; otherwise `npm install`.
      const useCi = existsSync(join(e2eDir, "package-lock.json"));
      // The e2e install runs the seed + repo lifecycle scripts: scrub orchestrator secrets.
      const child = spawn("npm", [useCi ? "ci" : "install"], { cwd: e2eDir, env: scrubEnv(/^DEV_/) });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm ${useCi ? "ci" : "install"} in e2e failed (code ${code})`)),
      );
    }),
};

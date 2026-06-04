// Prepares the repo's `e2e/` project to run the harness, BEFORE Filters B/C:
//   1. Bootstrap: if the repo has no `e2e/` project yet (first time), copy the
//      SEED (config/e2e: base Playwright config, fixtures, lint, tsconfig). That
//      scaffold lands in the first PR → from then on the repo owns it.
//   2. Install: install the e2e project's dependencies.
// Disk/process operations are injected, so the logic is verifiable; the real
// copy / `npm ci` are the boundary not covered by unit tests.

import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SetupDeps {
  hasProject(e2eDir: string): boolean; // does the e2e project already exist?
  bootstrap(e2eDir: string): void; // copy the seed into the repo
  install(e2eDir: string): Promise<void>;
}

export async function setupE2eProject(e2eDir: string, deps: SetupDeps): Promise<void> {
  if (!deps.hasProject(e2eDir)) deps.bootstrap(e2eDir); // first time: seed it
  await deps.install(e2eDir);
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
      const child = spawn("npm", [useCi ? "ci" : "install"], { cwd: e2eDir, env: { ...process.env } });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm ${useCi ? "ci" : "install"} in e2e failed (code ${code})`)),
      );
    }),
};

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
import { killTree } from "./execute";

// Default wall-clock budget for the e2e dependency install. A hung `npm ci` must
// never freeze the sequential queue; on expiry the process TREE is SIGKILLed and
// setup throws — the pipeline surfaces that as infra-error, never a code verdict.
export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000; // 10 min

export interface SetupOptions {
  signal?: AbortSignal; // operator cancel: kills the install tree and throws
  timeoutMs?: number;   // wall-clock budget; defaults to DEFAULT_E2E_INSTALL_TIMEOUT_MS
}

export interface SetupDeps {
  hasProject(e2eDir: string): boolean; // does the e2e project already exist?
  bootstrap(e2eDir: string): void; // copy the seed into the repo
  install(e2eDir: string, opts?: SetupOptions): Promise<void>;
}

export async function setupE2eProject(e2eDir: string, deps: SetupDeps, opts?: SetupOptions): Promise<void> {
  if (!deps.hasProject(e2eDir)) deps.bootstrap(e2eDir); // first time: seed it
  if (isInstallCurrent(e2eDir)) {
    console.log("[qa] e2e dependencies up to date; skipping npm ci");
    return;
  }
  if (opts?.signal?.aborted) throw new Error("e2e dependency install aborted by operator cancel");

  // Race the install against a timeout at the orchestration level (defense in depth:
  // the real spawn in defaultSetupDeps also SIGKILLs the tree). On timeout we throw,
  // which the pipeline maps to infra-error — same pattern as setupCodeProject.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`e2e dependency install timed out after ${timeoutMs}ms — killed`)), timeoutMs);
  });
  try {
    await Promise.race([deps.install(e2eDir, opts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
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
  install: (e2eDir, opts) =>
    new Promise((resolve, reject) => {
      // `npm ci` when there is a lockfile; otherwise `npm install`.
      const useCi = existsSync(join(e2eDir, "package-lock.json"));
      // The e2e install runs the seed + repo lifecycle scripts: scrub orchestrator secrets.
      // `detached: true` makes the child its own process-group leader so killTree can
      // reap the grandchildren npm forks (lifecycle scripts, node-gyp, ...).
      const child = spawn("npm", [useCi ? "ci" : "install"], { cwd: e2eDir, env: scrubEnv(/^DEV_/), detached: true });
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) opts?.signal?.removeEventListener("abort", onAbort);
        err ? reject(err) : resolve();
      };
      // A hung install must not block the sequential queue: kill the tree and throw
      // (the pipeline surfaces this as infra-error, not a code defect).
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        killTree(child);
        settle(new Error(`npm ${useCi ? "ci" : "install"} in e2e timed out after ${timeoutMs}ms — killed`));
      }, timeoutMs);
      const onAbort = opts?.signal
        ? () => {
            killTree(child);
            settle(new Error("e2e dependency install aborted by operator cancel"));
          }
        : undefined;
      if (onAbort) opts!.signal!.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
      child.on("close", (code) =>
        settle(code === 0 ? undefined : new Error(`npm ${useCi ? "ci" : "install"} in e2e failed (code ${code})`)),
      );
    }),
};

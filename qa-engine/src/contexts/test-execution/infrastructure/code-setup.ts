// qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts
// Code mode's install step — the code-mode analogue of setup.adapter.ts (e2e install). Body-moved
// from src/qa/code-runner.ts (migration-tier-4b, Slice 1), sibling to code-execution.runner.ts (the
// detect/run half). See that file's own header for the two deliberate differences from the legacy
// body (ProcessKillPort instead of a local killTree copy; an INJECTED Sandbox instead of an internal
// `resolveSandbox()` call that would read `process.env` inside qa-engine/src).

import { spawn } from "node:child_process";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { sandboxSpawnOptions, prepareSandboxWorkdir, type Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";
import { detectCodeProject, DEFAULT_CODE_MODE_TIMEOUT_MS, type CodeProject } from "./code-execution.runner.ts";

export interface CodeSetupDeps {
  detect(repoDir: string): CodeProject;
  install(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  // Hands the working copy to the unprivileged sandbox user BEFORE any untrusted spawn (§21). Runs
  // for every code-mode run — including the null-install ecosystems (Maven/Gradle/Rust) whose first
  // untrusted spawn is the test itself — so it must execute before the install-null early return.
  prepareWorkdir?(repoDir: string): void;
}

export async function setupCodeProject(
  repoDir: string,
  deps: CodeSetupDeps,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const project = deps.detect(repoDir);
  deps.prepareWorkdir?.(repoDir); // drop the working copy to the sandbox user before any spawn
  if (!project.install) return;
  if (opts?.signal?.aborted) throw new Error("code-mode install aborted by operator cancel");

  // Race install against a timeout at the orchestration level (defense in depth: the real
  // spawn below also SIGKILLs the child). A hung `npm ci`/`mvn`/`gradle` must not block the
  // sequential queue forever — on timeout we reject, which the pipeline maps to infra-error.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code-mode install timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([deps.install(project, repoDir, opts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// The REAL, spawning CodeSetupDeps — a FACTORY (not a plain constant), matching
// createDefaultCodeExecuteDeps's own sandbox-injection pattern (code-execution.runner.ts's header
// explains why `resolveSandbox()` cannot be called internally here).
export function createDefaultCodeSetupDeps(
  sandbox: Sandbox | null,
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): CodeSetupDeps {
  return {
    detect: (repoDir) => detectCodeProject(repoDir),
    prepareWorkdir: (repoDir) => prepareSandboxWorkdir(repoDir, sandbox),
    install: (project, repoDir, opts) =>
      new Promise((resolve, reject) => {
        const { cmd, args } = project.install!;
        const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve();
        };
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
        const timer = setTimeout(() => {
          processKill.killTree(child);
          settle(new Error(`code-mode install timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        opts?.signal?.addEventListener("abort", () => {
          processKill.killTree(child);
          settle(new Error("code-mode install aborted by operator cancel"));
        }, { once: true });
        child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
        child.on("close", (code) =>
          settle(code === 0 ? undefined : new Error(`code-mode install failed (${cmd} ${args.join(" ")}, exit ${code})`)),
        );
      }),
  };
}

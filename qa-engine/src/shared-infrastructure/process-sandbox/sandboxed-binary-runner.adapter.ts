// qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts
// The concrete SandboxedBinaryRunner: spawns a command over node:child_process, captures
// stdout/stderr, and kills the WHOLE process tree (via the injected ProcessKillPort) on
// timeout or operator abort — never leaves a hung child behind. Spawns detached:true so the
// child leads its own process group; ProcessKillAdapter's negative-pid kill reaps forked
// grandchildren (npx/playwright/mvn/gradle) that a plain child.kill() would orphan. This is
// the Seam-3 killTree decoupling: qa-engine no longer needs to borrow src/'s killTree — it
// owns its own via the injected ProcessKillPort (see F.2's makeSpawnRunner GAP comment,
// qa-engine/test/characterization/shadow-run.operator.ts).
//
// Mirrors the spawn/timeout/abort shape already proven in src/qa/execute.ts's
// defaultExecuteDeps.runSuite (settle-once guard, clearTimeout + removeEventListener on
// settle, killTree before resolving) — same behavior, ported as a generic leaf primitive
// instead of one hardcoded to Playwright.

import { spawn } from "node:child_process";
import type { SandboxedBinaryRunner, SandboxedBinaryRunnerDeps, SandboxedRunRequest, SandboxedRunResult } from "./sandboxed-binary-runner.ts";

export class SandboxedBinaryRunnerAdapter implements SandboxedBinaryRunner {
  constructor(private readonly deps: SandboxedBinaryRunnerDeps) {}

  run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(req.command, [...req.args], {
        cwd: req.cwd,
        env: req.env,
        detached: true, // own process group → ProcessKillPort.killTree reaps forked grandchildren
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) req.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      // Timeout guard: a hung binary must never hold the caller forever. Kill the whole
      // process tree and resolve timedOut:true — never rejects on a timeout (a wedged
      // process is a result, not a thrown error, matching SandboxedRunResult's contract).
      const timer = req.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            this.deps.processKill.killTree(child);
            settle(() => resolve({ exitCode: null, stdout, stderr, timedOut }));
          }, req.timeoutMs)
        : undefined;

      // Operator cancel: an already-fired signal is handled the same way as one that fires
      // mid-run — addEventListener with once:true fires synchronously for an already-aborted
      // signal too (per the DOM AbortSignal spec Node implements), so no separate "already
      // aborted" branch is needed.
      const onAbort = req.signal
        ? (): void => {
            timedOut = true;
            this.deps.processKill.killTree(child);
            settle(() => resolve({ exitCode: null, stdout, stderr, timedOut }));
          }
        : undefined;
      if (onAbort) req.signal!.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d: Buffer | string) => (stdout += String(d)));
      child.stderr?.on("data", (d: Buffer | string) => (stderr += String(d)));
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code) => settle(() => resolve({ exitCode: code, stdout, stderr, timedOut })));
    });
  }
}

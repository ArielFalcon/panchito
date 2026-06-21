import { spawn, type ChildProcess } from "node:child_process";
import { scrubEnv, resolveSandbox, sandboxSpawnOptions } from "../code-runner";

const DEFAULT_TIMEOUT_MS = 60_000;

function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

// One bounded external-binary invocation. Privilege-dropped (sandbox uid/gid when available,
// scrubEnv always). Resolves (never rejects) with code=null on spawn error or timeout — every
// extractor treats "tool missing" as a clean degrade, not a throw.
// extraEnv is merged last (on top of the scrubbed+sandbox env) for tool-specific vars like
// DFT_UNSTABLE. Security order: scrubEnv → sandboxSpawnOptions → extraEnv.
export function runBinary(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = scrubEnv();
    const sandbox = resolveSandbox();
    const spawnOpts = sandboxSpawnOptions(env, sandbox);
    const finalEnv = extraEnv ? { ...spawnOpts.env, ...extraEnv } : spawnOpts.env;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, ...spawnOpts, env: finalEnv, detached: true });
    } catch {
      resolve({ code: null, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "", stderr = "", settled = false;
    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      settle({ code: null, stdout, stderr: `timeout ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => settle({ code: null, stdout, stderr: String(e) }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

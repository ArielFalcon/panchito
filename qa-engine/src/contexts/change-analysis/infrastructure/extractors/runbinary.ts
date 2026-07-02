// The shared external-binary spawn wrapper for the static-signal extractors (complexity.ts,
// semantic-diff.ts, patterns.ts). Ported from src/qa/static-signal/exec.ts's runBinary, but
// implemented over the already-ported qa-engine leaf primitives instead of re-porting
// resolveSandbox/sandboxSpawnOptions (Plan 7.2's SandboxedBinaryRunnerAdapter + ProcessKillAdapter
// already own the spawn+kill-tree responsibility; scrub-env.ts already owns env scrubbing).
//
// Behavioral contract preserved EXACTLY from the legacy exec.ts: resolves (NEVER rejects) with
// code:null on spawn error or timeout — every extractor treats "tool missing" as a clean degrade,
// not a throw. SandboxedBinaryRunnerAdapter.run() REJECTS on a spawn "error" event (e.g. ENOENT);
// this wrapper catches that and maps it to the same {code:null, stdout:"", stderr} shape the
// legacy callers (and their tests) expect.
import { SandboxedBinaryRunnerAdapter } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../../../../shared-infrastructure/process-sandbox/scrub-env.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunResult { code: number | null; stdout: string; stderr: string }

const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });

// One bounded external-binary invocation. Env is scrubbed (scrubEnv always) — the privilege-drop
// sandbox (resolveSandbox/sandboxSpawnOptions in the legacy exec.ts) is a separate, container-root
// concern not exercised by these extractors' own tests; it is intentionally NOT re-ported here (out
// of scope for the static-signal extractor port — the extractors' behavior does not depend on it).
// Resolves (never rejects) with code=null on spawn error or timeout — every extractor treats
// "tool missing" as a clean degrade, not a throw.
// extraEnv is merged last (on top of the scrubbed env) for tool-specific vars like DFT_UNSTABLE.
export async function runBinary(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  const env = scrubEnv();
  const finalEnv = extraEnv ? { ...env, ...extraEnv } : env;

  try {
    const result = await runner.run({ command: cmd, args, cwd, env: finalEnv, timeoutMs });
    if (result.timedOut) {
      return { code: null, stdout: result.stdout, stderr: result.stderr || `timeout ${timeoutMs}ms` };
    }
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (e) {
    // Spawn error (e.g. binary missing — ENOENT): degrade to code:null, never throw.
    return { code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

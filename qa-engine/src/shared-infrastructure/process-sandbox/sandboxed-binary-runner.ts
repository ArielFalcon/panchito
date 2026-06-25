// qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts
// The shared spawn wrapper: a single entry point for running an untrusted/external binary with a
// scrubbed env and a process-tree kill on timeout/abort. Consolidates the spawn-then-killTree pattern
// duplicated across execute/code-runner/static-signal. v1 ships the interface + a thin default; the
// rich impl (privilege-drop sandbox, failure-capture wiring) lands when callers migrate (Plan 6).

import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

export interface SandboxedRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;     // already scrubbed (see scrub-env.ts)
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxedRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxedBinaryRunner {
  run(req: SandboxedRunRequest): Promise<SandboxedRunResult>;
}

// Constructor seam only in v1: the concrete spawn body is intentionally deferred to the adapter plans
// so this file stays a stable contract. It declares the ProcessKillPort dependency the real runner
// will consume, keeping the wiring explicit.
export interface SandboxedBinaryRunnerDeps {
  processKill: ProcessKillPort;
}

// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/deploy-gate-port.adapter.ts
// Bridge: DeployGatePort -> a REAL minimal implementation. NO sibling adapter exists (grep-confirmed
// zero `implements DeployGatePort` under qa-engine/src/) — this bridge IS the real gate, per Task
// E.0's own instruction ("Two bridges have NO existing concrete adapter to wrap and need a minimal
// REAL implementation: DeployGatePort... and RunHistoryPort").
//
// Follows the codebase's DI pattern: the actual /version poll primitive is injected (a plain async
// fn returning {serving: boolean}), so this adapter needs no real fetch/network in its own tests —
// the composition root (Task E.1/E.2) wires the injected poll to a real HTTP GET against
// app.dev.versionUrl, comparing the response body's sha to the target sha (mirrors the legacy
// waitForDeploy's own poll-until-match discipline). Bounded by timeoutMs; a genuine timeout
// resolves an InfraError (never a thrown exception — the gate result is a typed Result, consumed
// by RunQaUseCase's `isOk(gateResult)` check).
//
// NullDeployGateAdapter: for no-versionUrl apps (static sites) and the code target, where there is
// no DEV to wait for — resolves ok(true) immediately, matching src/pipeline.ts's own
// `versionUrl ? realGate : undefined` branch (RunQaUseCase's own deployGate is OPTIONAL for the same
// reason; this Null adapter exists so the composition root can wire a REAL DeployGatePort value even
// for apps that need "always ready" rather than leaving deployGate undefined).
import type { Sha } from "@kernel/sha.ts";
import type { Result } from "@kernel/result.ts";
import { ok, err } from "@kernel/result.ts";
import { InfraError } from "@kernel/domain-error.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";

export type VersionPollFn = (versionUrl: string, sha: Sha) => Promise<{ serving: boolean }>;

export interface DeployGatePortConfig {
  versionUrl: string;
  intervalMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeployGatePortAdapter implements DeployGatePort {
  constructor(
    private readonly poll: VersionPollFn,
    private readonly cfg: DeployGatePortConfig,
  ) {}

  async waitUntilServing(sha: Sha): Promise<Result<true, InfraError>> {
    const deadline = Date.now() + this.cfg.timeoutMs;
    while (Date.now() < deadline) {
      const { serving } = await this.poll(this.cfg.versionUrl, sha);
      if (serving) return ok(true);
      if (this.cfg.intervalMs > 0) await sleep(this.cfg.intervalMs);
    }
    return err(new InfraError(`DEV did not serve sha ${sha.toString()} within ${this.cfg.timeoutMs}ms (versionUrl=${this.cfg.versionUrl})`));
  }
}

// [SWAP] absent for static sites and the code target — always ready, no /version to poll.
export class NullDeployGateAdapter implements DeployGatePort {
  async waitUntilServing(_sha: Sha): Promise<Result<true, InfraError>> {
    return ok(true);
  }
}

// qa-engine/src/shared-kernel/ports/deploy-gate.port.ts
// Cross-cutting infra port for the deploy gate. Both qa-run-orchestration (the orchestrator waits
// for DEV before running any phase) and test-execution (the harness confirms DEV health before
// executing Playwright) consume this port. Neither context owns it exclusively — a port in one
// context cannot be imported at the port layer from another — so it lives in the kernel.
// [SWAP] absent for static sites and the code target (adapter returns ok(true) immediately).

import type { Result } from "@kernel/result.ts";
import type { InfraError } from "@kernel/domain-error.ts";
import type { Sha } from "@kernel/sha.ts";

export interface DeployGatePort {
  waitUntilServing(sha: Sha): Promise<Result<true, InfraError>>;
}

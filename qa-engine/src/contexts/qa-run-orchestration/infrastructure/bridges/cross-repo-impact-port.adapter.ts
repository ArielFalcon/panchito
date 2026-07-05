// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/cross-repo-impact-port.adapter.ts
//
// Design §3.3/ADR-C6: bridges service-topology's ResolveCrossRepoImpactUseCase into
// CrossRepoImpactPort. Owns NO static app context (unlike ServiceLinksPortAdapter/
// StructuralSignalPortAdapter) — every call is per-triggerRepo, since the triggering service is a
// DIFFERENT repo per cross-repo run; there is no single "the" repoDir to pin at construction time.
//
// Performs the structural cast from the domain VO (service-topology/domain/cross-repo-impact.ts) to
// the ports barrel's port-local mirrors (application/ports/index.ts) — the SAME cast
// ServiceLinksPortAdapter performs for ServiceLink/ContractDrift (ADR-C6, the ports barrel's own
// "no cross-context import" rule). Plain assignment, no `as unknown as`: a future field divergence
// between the mirrors and the domain must FAIL typecheck here, not be silenced by a double-cast.
//
// Fail-open at every layer: ResolveCrossRepoImpactUseCase.resolve() itself never throws (see that
// use-case's own header); this adapter adds no further try/catch, matching ServiceLinksPortAdapter's
// own "the collaborator's contract IS the fail-open guarantee" posture where the collaborator's
// contract already covers it.
import type { CrossRepoImpactPort, CrossRepoImpact, ServiceLink } from "../../application/ports/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { ResolveCrossRepoImpactUseCase, type CrossRepoVcsRead, type MirrorRegistryLike } from "@contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts";

export interface CrossRepoImpactPortAdapterDeps {
  mirrors: MirrorRegistryLike;
  makeVcs: (repoDir: string) => CrossRepoVcsRead;
  codeGraph: CodeGraphPort;
  runner: SandboxedBinaryRunner;
}

export class CrossRepoImpactPortAdapter implements CrossRepoImpactPort {
  private readonly useCase: ResolveCrossRepoImpactUseCase;

  constructor(deps: CrossRepoImpactPortAdapterDeps) {
    this.useCase = new ResolveCrossRepoImpactUseCase(deps.mirrors, deps.makeVcs, deps.codeGraph, deps.runner);
  }

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null> {
    // Plain assignment — the port-local ServiceLink mirror (barrel) is structurally identical to
    // service-topology's domain ServiceLink, so TS structural typing holds with NO cast.
    return this.useCase.resolve(triggerRepo, triggerSha, resolvedLinks);
  }
}

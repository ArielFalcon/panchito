// service-topology/infrastructure/stub-resolver.adapter.ts
// The v1 wiring: service boundary resolution is off-path in the initial wiring.
// Returns empty results. Swap for OpenApiHttpResolver once yield is measured.
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef } from "../domain/index.ts";

export class StubServiceBoundaryResolver implements ServiceBoundaryResolverPort {
  async resolveLinks(_system: RepoRef[], _front: RepoRef): Promise<ResolveLinksResult> {
    return { links: [], drift: [], external: [], unresolved: [] };
  }
}

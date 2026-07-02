// service-topology/infrastructure/resolver-factory.ts
// Piece 2 of the stitcher config→resolver loader (step 2 + step 3): turns a validated
// BoundaryProfile[] (from BoundaryProfileProviderPort) into one composed
// ServiceBoundaryResolverPort.
//
// The internal registry is the SINGLE place a transport is mapped to its adapter constructor —
// step 3 exercises exactly the extension seam step 2 designed for: widening BoundaryProfile
// (domain/index.ts) to include EventBoundaryProfile forced TypeScript to require an `event` key
// here (see RESOLVER_REGISTRY's type below), so adding EventResolver is the ONLY change this
// file needed. A profile whose `transport` has no registered constructor (e.g. a future `rpc`)
// is warned about and skipped, never a throw.
import type { ServiceBoundaryResolverPort } from "../application/ports/index.ts";
import type { BoundaryProfile, HttpBoundaryProfile, EventBoundaryProfile } from "../domain/index.ts";
import { CompositeServiceBoundaryResolver } from "./composite-resolver.adapter.ts";
import { OpenApiHttpResolver } from "./openapi-http-resolver.adapter.ts";
import { EventResolver } from "./event-resolver.adapter.ts";

type ResolverBuilder = (profile: BoundaryProfile) => ServiceBoundaryResolverPort;

// Keyed by BoundaryProfile["transport"] — "http" and "event" are members of the open union
// (domain/index.ts), so this registry is exhaustive over the current type. Widening the union
// further (e.g. rpc) widens the key type here first, then adds one entry — the SAME mechanism
// that made this "event" entry a compile-time-required addition when step 3 widened the union.
const RESOLVER_REGISTRY: Record<BoundaryProfile["transport"], ResolverBuilder> = {
  http: (profile) => new OpenApiHttpResolver(profile as HttpBoundaryProfile),
  event: (profile) => new EventResolver(profile as EventBoundaryProfile),
};

/** Compose a ServiceBoundaryResolverPort from an app's declared boundary profiles. Never
 *  throws: an unrecognized transport is skipped (loud warn), and an empty/all-unrecognized
 *  input yields a CompositeServiceBoundaryResolver with zero resolvers, which already
 *  fail-opens to an empty ResolveLinksResult. */
export function buildServiceBoundaryResolver(profiles: readonly BoundaryProfile[]): ServiceBoundaryResolverPort {
  const resolvers: ServiceBoundaryResolverPort[] = [];
  for (const profile of profiles) {
    const build = RESOLVER_REGISTRY[profile.transport];
    if (!build) {
      console.warn(
        `[buildServiceBoundaryResolver] no resolver registered for transport "${profile.transport}" — skipping profile`,
      );
      continue;
    }
    resolvers.push(build(profile));
  }
  return new CompositeServiceBoundaryResolver(resolvers);
}

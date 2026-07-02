// service-topology/domain/index.ts
// Cross-repo boundary domain. Transport-agnostic VOs — never name OpenAPI/gRPC/NATS.
// ServiceSymbolRef (cross-repo) is intentionally distinct from LocalSymbolRef (intra-repo).
// The domain does not depend on any shared-kernel port — it is pure data.

/** Identifies a repo and the filesystem path to its working copy. */
export interface RepoRef {
  repo: string;       // repo identity, e.g. "ArielFalcon/ms-name-orders"
  mirrorDir: string;  // absolute filesystem path of the mirror working copy
}

/** Cross-repo symbol reference. Only used in service-topology — NOT the same as LocalSymbolRef. */
export interface ServiceSymbolRef {
  repo: string;   // repo identity (never a filesystem path)
  file: string;   // repo-relative file path
  symbol: string; // operationId, function name, or topic — opaque to the domain
}

/** A resolved cross-repo dependency link. Transport is open-union; the domain treats it as opaque. */
export interface ServiceLink {
  from: ServiceSymbolRef;              // egress call-site (e.g. a frontend *.api.ts method)
  to: ServiceSymbolRef;                // ingress handler (e.g. a backend controller/operationId)
  transport: "http" | "event" | "rpc"; // open set; kept as a union to type-check valid values
  contractRef?: string;                // operationId, proto method, topic — opaque to the domain
  confidence: number;                  // [0, 1] — structural match is always 1.0 from OpenApiHttpResolver
  source: string;                      // which strategy produced this link (for audit)
}

/** A detected FE↔BE contract drift: the frontend calls an endpoint the backend contract does not declare. */
export interface ContractDrift {
  from: ServiceSymbolRef; // the egress call-site that triggered the drift
  verb: string;           // HTTP verb (uppercase)
  path: string;           // the raw path the frontend called (with any service prefix intact)
}

/** A call-site that targets a service outside the indexed repo set. */
export interface ExternalCall {
  path: string;  // the raw path arg (service prefix + resource)
  verb: string;  // HTTP verb (uppercase)
  from?: ServiceSymbolRef; // origin call-site (file + symbol); optional for backward compat
}

/** A call-site whose path argument could not be statically resolved (dynamic/method-param expression). */
export interface UnresolvedCall {
  rawArg: string; // the raw argument text as it appears in the source
  file: string;   // repo-relative file path of the call-site
}

// ---- Boundary profiles ----
// The config contract for app-specific HTTP boundary conventions (Invariant #1: "nothing
// app-specific in the engine core"). Profile TYPES are the exception to "never name transport"
// above — they ARE the config contract an app supplies, not a link VO. The engine core reads
// only through these types; no app's literal patterns (receiver, prefix template, repo naming)
// ever appear in src/.

/** Identifies a call-site SHAPE (a key into the in-core CallSiteCatalog) plus the concrete
 *  receiver an app's code uses for that shape. The shape lives in the core; the receiver is
 *  config, never hardcoded. */
export interface CallSiteRef {
  kind: string;       // key into the in-core CallSiteCatalog, e.g. "receiver-verb-call"
  receiver?: string;  // e.g. "this.rest" — supplied by config, never hardcoded in the core
}

/** An app's HTTP boundary convention: how its frontend calls its backends, and where each
 *  backend's OpenAPI contract lives. One HttpBoundaryProfile per app, supplied via config. */
export interface HttpBoundaryProfile {
  transport: "http";
  // Filename-suffix glob of front egress files to scan, e.g. "**/*.api.ts" or "*.api.ts" — NOT
  // a full glob: only these two shapes are supported (compileFileGlob), because the directory
  // walk already recurses and only ever tests a bare filename. Any other shape (e.g. a
  // directory-structured "**/api/*.ts") warns and matches no files (fail-closed).
  frontFiles: string;
  frontCallSite: CallSiteRef;
  servicePrefixTemplate: string;   // e.g. "name-{service}-api"
  serviceRepoTemplate: string;     // e.g. "ms-name-{service}"
  openApiPath: string;             // per-repo relative path to the OpenAPI file (static-file)
}

/** Identifies an EVENT call-site SHAPE (a key into the in-core event-pattern catalog) plus the
 *  concrete class/method names an app's code uses for that shape. Mirrors CallSiteRef's split:
 *  the shape (how to recognize a listener/publisher pair) lives in the core catalog; every
 *  concrete symbol name below is config, never hardcoded (Invariant #1). */
export interface EventPatternRef {
  kind: string;                 // catalog key, e.g. "class-based-domain-events"
  listenerBaseType: string;     // e.g. "ListenerMessageDelegate"
  listenerEventCall: string;    // e.g. "convertMsgToSpecificType"
  subscriberBaseType: string;   // e.g. "DomainEventSubscriber"
  publishCall: string;          // e.g. "publishGenericMessage"
}

/** An app's EVENT boundary convention: how its backend repos publish/consume domain events
 *  (NATS, RabbitMQ, or any broker sharing the same class-based code convention — the transport
 *  is opaque to this profile, only the class/method SHAPE matters). One EventBoundaryProfile
 *  per app, supplied via config. */
export interface EventBoundaryProfile {
  transport: "event";
  files: string;                // glob of files to scan, e.g. "**/*.java"
  eventPattern: EventPatternRef;
}

/** Open union of boundary profiles, discriminated by `transport`. "http" and "event" exist
 *  today; a future transport (e.g. rpc) adds a sibling variant here, never a branch in the
 *  core — the widened union is what forces resolver-factory.ts to register a new builder. */
export type BoundaryProfile = HttpBoundaryProfile | EventBoundaryProfile;

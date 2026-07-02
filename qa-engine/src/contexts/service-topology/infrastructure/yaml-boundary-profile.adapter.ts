// service-topology/infrastructure/yaml-boundary-profile.adapter.ts
// Piece 1 of the stitcher config→resolver loader (step 2 + step 3): reads an app's
// `boundaries[]` declaration from config/apps/<app>.yaml and validates it into BoundaryProfile[]
// (a mix of HttpBoundaryProfile and EventBoundaryProfile entries, dispatched by `transport`).
// Invariant #1: every app-specific pattern (receiver, prefix/repo templates, OpenAPI path,
// listener/publisher base-type and method names) is a config STRING here, never a literal in
// the engine core.
//
// The reader is INJECTED — production wires config/apps/<name>.yaml + readFileSync + env
// expansion (mirroring src/orchestrator/config-loader.ts); tests pass a stub string, so this
// module never touches the filesystem directly.
//
// Validation is LOUD + fail-CLOSED per entry (mirrors the config compilers from step 1,
// e.g. boundary-template.ts): an entry with an unsupported/missing transport, or any
// missing/malformed required field, is warned about by name + index and SKIPPED — it never
// throws past this adapter. A totally malformed YAML, a non-array `boundaries`, or a reader
// that throws all degrade to [] (fail-open).
import { parse as parseYaml } from "yaml";
import type { BoundaryProfileProviderPort } from "../application/ports/index.ts";
import type { BoundaryProfile, HttpBoundaryProfile, EventBoundaryProfile, CallSiteRef, EventPatternRef } from "../domain/index.ts";
import { KNOWN_CALL_SITE_KINDS } from "./call-site-catalog.ts";
import { KNOWN_EVENT_PATTERN_KINDS } from "./event-pattern-catalog.ts";

const REQUIRED_HTTP_STRING_FIELDS = [
  "frontFiles",
  "servicePrefixTemplate",
  "serviceRepoTemplate",
  "openApiPath",
] as const;

const REQUIRED_EVENT_PATTERN_STRING_FIELDS = [
  "listenerBaseType",
  "listenerEventCall",
  "subscriberBaseType",
  "publishCall",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a single raw `boundaries[]` entry into an HttpBoundaryProfile, or null if it
 *  does not structurally conform. Pure — no I/O, no logging — so the caller can decide how
 *  to report the reason (adapter warns with app + index context). */
export function parseHttpBoundaryProfile(raw: unknown): HttpBoundaryProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["transport"] !== "http") return null; // unknown/missing transport for THIS parser

  for (const field of REQUIRED_HTTP_STRING_FIELDS) {
    const value = raw[field];
    // A blank string is structurally a string but unusable config (e.g. openApiPath: "" would
    // read the repo root as a file) — reject it up front rather than degrade downstream.
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const rawCallSite = raw["frontCallSite"];
  if (!isRecord(rawCallSite) || typeof rawCallSite["kind"] !== "string") return null;
  // The kind must name a shape the core can actually extract (a CallSiteCatalog key); an
  // unknown kind would silently yield zero call-sites, so reject it at load time (loud).
  if (!KNOWN_CALL_SITE_KINDS.has(rawCallSite["kind"])) return null;
  const frontCallSite: CallSiteRef = { kind: rawCallSite["kind"] };
  if (typeof rawCallSite["receiver"] === "string") frontCallSite.receiver = rawCallSite["receiver"];

  return {
    transport: "http",
    frontFiles: raw["frontFiles"] as string,
    frontCallSite,
    servicePrefixTemplate: raw["servicePrefixTemplate"] as string,
    serviceRepoTemplate: raw["serviceRepoTemplate"] as string,
    openApiPath: raw["openApiPath"] as string,
  };
}

/** Validate a single raw `boundaries[]` entry into an EventBoundaryProfile, or null if it does
 *  not structurally conform. Pure — no I/O, no logging — mirrors parseHttpBoundaryProfile's
 *  validation style exactly (isRecord guard, required-string-field rejection with blank-string
 *  rejection, plus an eventPattern.kind check against the in-core catalog). */
export function parseEventBoundaryProfile(raw: unknown): EventBoundaryProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["transport"] !== "event") return null; // unknown/missing transport for THIS parser

  const files = raw["files"];
  if (typeof files !== "string" || files.trim().length === 0) return null;

  const rawPattern = raw["eventPattern"];
  if (!isRecord(rawPattern)) return null;
  if (typeof rawPattern["kind"] !== "string") return null;
  // The kind must name a shape the core can actually extract (an EventPatternCatalog key); an
  // unknown kind would silently yield zero extracted occurrences, so reject it at load time.
  if (!KNOWN_EVENT_PATTERN_KINDS.has(rawPattern["kind"])) return null;

  for (const field of REQUIRED_EVENT_PATTERN_STRING_FIELDS) {
    const value = rawPattern[field];
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const eventPattern: EventPatternRef = {
    kind: rawPattern["kind"],
    listenerBaseType: rawPattern["listenerBaseType"] as string,
    listenerEventCall: rawPattern["listenerEventCall"] as string,
    subscriberBaseType: rawPattern["subscriberBaseType"] as string,
    publishCall: rawPattern["publishCall"] as string,
  };

  return { transport: "event", files, eventPattern };
}

/** Dispatch a single raw `boundaries[]` entry to the parser matching its `transport` field.
 *  Returns null for an entry whose transport is missing/unrecognized OR whose recognized
 *  parser rejects it — the caller (forApp) cannot distinguish "unknown transport" from
 *  "malformed known transport" from this return value alone, which is intentional: both cases
 *  warn+skip identically (mirrors the pre-dispatch behavior for http-only entries). */
function parseBoundaryProfile(raw: unknown): BoundaryProfile | null {
  if (!isRecord(raw)) return null;
  switch (raw["transport"]) {
    case "http":
      return parseHttpBoundaryProfile(raw);
    case "event":
      return parseEventBoundaryProfile(raw);
    default:
      return null; // unsupported/missing transport — no parser registered
  }
}

export class YamlBoundaryProfileAdapter implements BoundaryProfileProviderPort {
  constructor(private readonly readAppYaml: (appName: string) => string) {}

  async forApp(appName: string): Promise<BoundaryProfile[]> {
    let content: string;
    try {
      content = this.readAppYaml(appName);
    } catch (err) {
      console.warn(
        `[YamlBoundaryProfileAdapter] failed to read config for app "${appName}":`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch (err) {
      console.warn(
        `[YamlBoundaryProfileAdapter] failed to parse YAML for app "${appName}":`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    if (!isRecord(doc)) return []; // malformed document root — fail-open
    const rawBoundaries = doc["boundaries"];
    if (rawBoundaries === undefined) return []; // no boundaries declared — valid, not an error
    if (!Array.isArray(rawBoundaries)) {
      console.warn(`[YamlBoundaryProfileAdapter] app "${appName}": "boundaries" is not an array — ignoring`);
      return [];
    }

    const profiles: BoundaryProfile[] = [];
    rawBoundaries.forEach((entry, index) => {
      const profile = parseBoundaryProfile(entry);
      if (profile === null) {
        console.warn(
          `[YamlBoundaryProfileAdapter] app "${appName}": boundaries[${index}] is malformed or declares an unsupported transport — skipping`,
        );
        return;
      }
      profiles.push(profile);
    });
    return profiles;
  }
}

// service-topology/infrastructure/event-resolver.adapter.ts
// Config-driven EVENT boundary resolver (stitcher step 3). Every app-specific pattern (listener
// base type, event-consume call, subscriber base type, publish call) comes from the injected
// EventBoundaryProfile — this class carries no literal from any one watched app (Invariant #1).
//
// Rebuilds a prior COUPLED spike (EventTopicResolver, spiked then deleted) which hardcoded
// nname literals directly in the core AND had a bug: its variant-B publisher symbol resolution
// took the FIRST class declared in the file instead of the class ENCLOSING the publish call.
// That bug is fixed in event-pattern-catalog.ts (findEnclosingClass) — see its regression test.
//
//   SCAN:  walk every repo in the pool matching profile.files, run the event-pattern-catalog
//          extractor (keyed by profile.eventPattern.kind) per file, collect raw occurrences
//   BUILD: resolve variant-A's two-pass join (broker-interface name → model name, then
//          broker-impl class → broker-interface name) into a flat list of publishers, merge
//          with variant-B publishers and all listeners
//   JOIN:  for each listener, try an EXACT event-name match across all publishers first; if
//          none, fall back to a stem match (strip trailing "Event"/"Model" from both sides and
//          compare case-sensitively) — exact confidence 1.0, stem confidence 0.7
//   EMIT:  ServiceLink[] per matched (publisher, listener) pair; unmatched occurrences on either
//          side produce NO link (no diagnostics bucket — see design note below)
//
// Fail-open: resolveLinks NEVER throws. A per-repo/per-file read/parse error skips that unit and
// continues; an unknown profile.eventPattern.kind fails open to an empty result (mirrors
// OpenApiHttpResolver's extractEgress `if (!extractor) return [];` pattern).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef, ServiceLink, ServiceSymbolRef, EventBoundaryProfile } from "../domain/index.ts";
import { EventPatternCatalog, type EventPatternOccurrence } from "./event-pattern-catalog.ts";
import { compileFileGlob } from "./glob-suffix.ts";

const EXACT_MATCH_CONFIDENCE = 1.0;
const STEM_MATCH_CONFIDENCE = 0.7;

/** Recursively walk a directory, collecting files matching the predicate.
 *  Mirrors openapi-http-resolver.adapter.ts's `walk()` helper — same recursive-readdir shape,
 *  adapted here for the profile's `files` glob (`.java` in nname's real usage, but generic).
 *
 *  DETERMINISM (project invariant #1: stable, deterministic behavior): `readdirSync` order is
 *  filesystem-dependent (not guaranteed alphabetical on every OS/filesystem). This resolver's
 *  JOIN is first-match-wins (`publishers.find(...)` in resolveLinks) — when two publishers in
 *  the scanned pool publish the SAME event name (realistic: nname's dual-transport NATS+Rabbit
 *  setup makes a relay/dual-publish of one event plausible), an unsorted walk would make the
 *  emitted link's `from` symbol depend on raw filesystem order, i.e. non-deterministic across
 *  runs/environments. Sorting here fixes the file COLLECTION order deterministically; it is
 *  local to this function and does not require the caller to also sort. */
function walk(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

/** Flat resolved occurrence with its ORIGIN repo attached (the catalog is per-file, this
 *  resolver is the layer that knows which repo a file came from). */
interface RepoOccurrence {
  repo: RepoRef;
  file: string; // repo-relative path
  occurrence: EventPatternOccurrence;
}

/** Strip a trailing "Event" or "Model" suffix from a name, for stem comparison. Returns the
 *  name unchanged if it has neither suffix (so e.g. "Foo" stems to "Foo", not dropped). */
function stem(name: string): string {
  if (name.endsWith("Event")) return name.slice(0, -"Event".length);
  if (name.endsWith("Model")) return name.slice(0, -"Model".length);
  return name;
}

export class EventResolver implements ServiceBoundaryResolverPort {
  private readonly isEventFile: (filename: string) => boolean;

  constructor(private readonly profile: EventBoundaryProfile) {
    this.isEventFile = compileFileGlob(profile.files);
  }

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    const empty: ResolveLinksResult = { links: [], drift: [], external: [], unresolved: [] };

    // Unknown eventPattern.kind — fail open to empty, mirrors extractEgress's
    // `if (!extractor) return [];` in the HTTP resolver.
    const extractor = EventPatternCatalog[this.profile.eventPattern.kind];
    if (!extractor) return empty;

    // Events are backend↔backend: there is no separate "front" role the way HTTP has one.
    // Treat [...system, front] as ONE pool of repos to scan for both listeners and publishers —
    // in nname's real topology, any of these repos could theoretically publish OR listen, and
    // the port signature (system, front) cannot be changed, so `front` is folded into the same
    // scan pool rather than treated as a distinct egress-only role. Dedup by repo identity so a
    // caller passing the same repo in both `system` and as `front` does not double-scan it.
    const seenRepos = new Set<string>();
    const pool: RepoRef[] = [];
    for (const repo of [...system, front]) {
      if (seenRepos.has(repo.repo)) continue;
      seenRepos.add(repo.repo);
      pool.push(repo);
    }

    // --- SCAN: walk every repo, extract raw occurrences per file ---
    const occurrences: RepoOccurrence[] = [];
    for (const repo of pool) {
      const files = walk(repo.mirrorDir, (name) => this.isEventFile(name));
      for (const full of files) {
        let text: string;
        try { text = readFileSync(full, "utf8"); } catch { continue; }
        const relFile = full.slice(repo.mirrorDir.length + 1); // make repo-relative
        for (const occurrence of extractor(text, this.profile.eventPattern)) {
          occurrences.push({ repo, file: relFile, occurrence });
        }
      }
    }

    // --- BUILD: resolve variant-A's two-pass join, merge with variant-B + listeners ---
    // Pass 1: broker-interface name → model name (e.g. "BarEventBroker" → "BarModel").
    const modelOfBrokerInterface = new Map<string, string>();
    for (const o of occurrences) {
      if (o.occurrence.role === "broker-interface") {
        modelOfBrokerInterface.set(o.occurrence.className, o.occurrence.modelName);
      }
    }

    // Pass 2: broker-impl class → resolved event name (via the broker-interface map), plus
    // variant-B publishers directly. Both become flat { repo, file, className, eventName }.
    interface FlatPublisher { repo: RepoRef; file: string; className: string; eventName: string }
    const publishers: FlatPublisher[] = [];
    for (const o of occurrences) {
      if (o.occurrence.role === "broker-impl") {
        const modelName = modelOfBrokerInterface.get(o.occurrence.brokerInterfaceName);
        if (modelName === undefined) continue; // impl implements an interface we never saw as a broker
        publishers.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: modelName });
      } else if (o.occurrence.role === "publisher") {
        publishers.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: o.occurrence.eventName });
      }
    }

    interface FlatListener { repo: RepoRef; file: string; className: string; eventName: string }
    const listeners: FlatListener[] = [];
    for (const o of occurrences) {
      if (o.occurrence.role === "listener") {
        listeners.push({ repo: o.repo, file: o.file, className: o.occurrence.className, eventName: o.occurrence.eventName });
      }
    }

    // --- JOIN: for each listener, try exact match first, then stem match ---
    const links: ServiceLink[] = [];
    for (const listener of listeners) {
      const exactMatch = publishers.find((p) => p.eventName === listener.eventName);
      const matched = exactMatch ?? publishers.find((p) => stem(p.eventName) === stem(listener.eventName));
      if (!matched) continue; // no counterpart anywhere in the scanned pool — no link, no throw

      const confidence = exactMatch ? EXACT_MATCH_CONFIDENCE : STEM_MATCH_CONFIDENCE;
      const fromRef: ServiceSymbolRef = { repo: matched.repo.repo, file: matched.file, symbol: matched.className };
      const toRef: ServiceSymbolRef = { repo: listener.repo.repo, file: listener.file, symbol: listener.className };
      links.push({
        from: fromRef,
        to: toRef,
        transport: "event",
        // contractRef uses the PUBLISHER's literal event name string, not the listener's, for
        // consistency: the publisher is the authoritative source of the event's identity even
        // when the join was a stem match (the listener's name is a variant, the publisher's is
        // the canonical one being broadcast).
        contractRef: matched.eventName,
        confidence,
        source: "event-topic",
      });
    }

    // Events have no direct equivalent of HTTP "contract drift" (a declared-but-uncalled
    // contract) or "external service" (a call outside the indexed repo set) — the brief prefers
    // omitting a bucket over adding a new `unmatchedEvents` bucket to ResolveLinksResult (the
    // port interface is not to be modified). Default to empty arrays.
    return { links, drift: [], external: [], unresolved: [] };
  }
}

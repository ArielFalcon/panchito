// src/contexts/objective-signal/infrastructure/coverage-collector.adapter.ts
// Composite CoverageCollectorPort: dispatches to the per-ecosystem collector and merges. An
// ecosystem with no collector yields an empty report → DecideCoverageService returns "unknown" →
// NEVER blocks (the keystone invariant lives in the decide service; this stays fail-open).
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

// Default per-collector timeout (ms). A slow ecosystem collector must not hang the sequential
// queue — the pipeline is single-run-at-a-time and a stuck collector would block indefinitely.
// A timed-out collector degrades to an empty CoverageReport (→ "unknown" → NEVER blocks),
// consistent with the keystone invariant: coverage unknown never blocks publish.
const COLLECTOR_TIMEOUT_MS = 30_000;

// Wraps a single collector call with a bounded AbortSignal timeout so a stuck collector degrades
// gracefully to an empty report rather than hanging Promise.all (which would freeze the queue).
async function collectWithTimeout(
  collector: CoverageCollectorPort,
  specDir: string,
  namespace: string,
  timeoutMs = COLLECTOR_TIMEOUT_MS,
): Promise<CoverageReport> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ covered: [] }), timeoutMs);
    collector.collect(specDir, namespace).then(
      (r) => { clearTimeout(timer); resolve(r); },
      () => { clearTimeout(timer); resolve({ covered: [] }); }, // error → empty (fail-open)
    );
  });
}

export class CoverageCollectorAdapter implements CoverageCollectorPort {
  constructor(
    private readonly collectors: readonly CoverageCollectorPort[],
    private readonly timeoutMs = COLLECTOR_TIMEOUT_MS,
  ) {}

  async collect(specDir: string, namespace: string): Promise<CoverageReport> {
    // Each collector runs with a bounded timeout. A slow/hanging collector degrades to an empty
    // report (→ DecideCoverageService returns "unknown" → NEVER blocks — the keystone invariant).
    const all = await Promise.all(
      this.collectors.map((c) => collectWithTimeout(c, specDir, namespace, this.timeoutMs)),
    );
    const merged = new Map<string, Set<number>>();
    for (const r of all) for (const c of r.covered) {
      const set = merged.get(c.file) ?? new Set<number>();
      for (const ln of c.lines) set.add(ln);
      merged.set(c.file, set);
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

// Test-data hygiene against the real DEV database. Instead of an ephemeral DB, we
// namespace by SHA: every entity a test creates carries the prefix qa-bot-<sha7>,
// so it is identifiable and cleanable (each test removes it in its teardown).
// Pure functions (verifiable without network).

// Short SHA (7 chars) — the canonical form for branches, namespaces and titles.
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// The run's data namespace. When a runId is given it appends a per-run token, so two
// runs of the SAME sha (a re-trigger, a webhook redelivery) never share a namespace —
// closing same-sha DEV-data collisions and stale coverage-dump merges. Without a runId
// it returns the backward-compatible sha-only form. The SAME function is used by the
// orchestrator (to create the namespace) and by the orphan-cleanup (to reconstruct a
// prior run's namespace from its record), so they agree by construction.
export function testDataNamespace(prefix: string, sha: string, runId?: string): string {
  const base = `${prefix}-${shortSha(sha)}`;
  return runId ? `${base}-${runToken(runId)}` : base;
}

// A short, entity-name-safe token unique to a run, taken from the unique tail of the
// runId (run-<sha7>-<ts36> → <ts36>).
// A short, entity-name-safe token unique to a run, taken from the random tail of the runId
// (format `run-<sha7>-<ts36>-<hex8>` → the `<hex8>` random suffix, which is what guarantees
// uniqueness even for two same-sha runs in the same millisecond).
function runToken(runId: string): string {
  const tail = runId.split("-").pop() ?? runId;
  return tail.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "run";
}

// Test-data hygiene against the real DEV database. Instead of an ephemeral DB, we
// namespace by SHA: every entity a test creates carries the prefix qa-bot-<sha7>,
// so it is identifiable and cleanable (each test removes it in its teardown).
// Pure functions (verifiable without network).

// Short SHA (7 chars) — the canonical form for branches, namespaces and titles.
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function testDataNamespace(prefix: string, sha: string): string {
  return `${prefix}-${shortSha(sha)}`;
}

// qa-engine/src/contexts/workspace-and-publication/infrastructure/github-http.ts
// Shared HTTP-injection contract + GitHub's title/body clamps for the publication adapters
// (GitHubPrAdapter/GitHubIssueAdapter). migration-tier-4a: both adapters now own their GitHub HTTP
// calls directly instead of receiving closures built around src/integrations/github.ts's `github`
// object. `fetch` and the auth-header supplier are injected so GITHUB_TOKEN (env-agnostic adapter
// invariant) is never read here — the composition factory (src/server/rewritten-engine-factory.ts,
// the sole src<->qa-engine seam) builds the real authHeaders() closure from requireEnv("GITHUB_TOKEN").
//
// GitHub's documented hard limits for Issue/PR fields — exceeding either is a 422 ("title/body is too
// long"). Deliberately DUPLICATED from src/integrations/github.ts's own GITHUB_MAX_TITLE/BODY, not
// shared: qa-engine may never import src/ (arch:check's no-src-import-in-qa-engine rule), and
// github.ts's own createPullRequest/enableAutoMerge/mergePullRequest stay byte-identical for the
// maintainer-runtime/app-admin trust domain — a deliberate dual-transport split (see design decision
// table's "github.ts" row: distinct trust domains, accepted overlap).
export const GITHUB_MAX_TITLE = 256;
export const GITHUB_MAX_BODY = 65536;

export function clampTitle(title: string): string {
  if (title.length <= GITHUB_MAX_TITLE) return title;
  return title.slice(0, GITHUB_MAX_TITLE - 1).trimEnd() + "…";
}

export function clampBody(body: string): string {
  if (body.length <= GITHUB_MAX_BODY) return body;
  const notice = "\n\n_…(truncated to fit GitHub's 65536-character limit)_";
  return body.slice(0, GITHUB_MAX_BODY - notice.length) + notice;
}

// Injected by the factory: `fetch` is the raw undici fetch, `authHeaders` returns the
// Authorization header built from the shell-supplied GITHUB_TOKEN. Neither adapter reads env or
// imports src/ — both effects arrive from the composition root, matching VcsWriteAdapter's own
// "real-wiring obligation is on the injector, not this class" precedent.
export interface GitHubHttpDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  authHeaders(): Record<string, string>;
}

// GitHub-as-identity for the control plane. The TUI runs the OAuth device flow and hands the
// server a GitHub user token; the server (1) verifies WHO that token belongs to and (2) checks
// they hold push/admin on a watched repo — the authorization rule. Both calls use the USER's
// token (never a server credential), so a non-collaborator on a private repo simply 404s.
//
// fetch is injected (FetchLike) so the HTTP boundary stays unit-testable, matching the rest of
// the codebase's *Deps pattern.

export type FetchLike = typeof fetch;

const API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

function authHeaders(githubToken: string): HeadersInit {
  return { authorization: `Bearer ${githubToken}`, accept: ACCEPT };
}

// verifyGithubIdentity resolves the GitHub login a token belongs to, or null if the token is
// rejected/unusable. This is the authenticated identity — never trust a username the client claims.
export async function verifyGithubIdentity(githubToken: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const res = await fetchImpl(`${API}/user`, { headers: authHeaders(githubToken) });
  if (!res.ok) return null;
  const body = (await res.json()) as { login?: unknown };
  return typeof body.login === "string" && body.login !== "" ? body.login : null;
}

// authorizeUser reports whether the token's owner can push to (or administer) at least one of
// the watched repos. GET /repos/{owner}/{repo} with a user token includes that user's own
// `permissions` object; push/maintain/admin grants access, pull-only or 404 does not.
export async function authorizeUser(
  githubToken: string,
  repos: string[],
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const headers = authHeaders(githubToken);
  for (const repo of repos) {
    const res = await fetchImpl(`${API}/repos/${repo}`, { headers });
    if (!res.ok) continue; // not a collaborator (404) or other access error
    const body = (await res.json()) as { permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } };
    const p = body.permissions;
    if (p && (p.push || p.maintain || p.admin)) return true;
  }
  return false;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGithubIdentity, authorizeUser, type FetchLike } from "./github-auth";

// fakeGithub builds a fetch that answers a fixed route table (url → {status, body}) and
// records the Authorization header it was called with, so tests can assert the token is sent.
function fakeGithub(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization") });
    const r = routes[url];
    if (!r) return new Response(null, { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return { fetchImpl, seen };
}

test("verifyGithubIdentity returns the login for a valid token", async () => {
  const { fetchImpl, seen } = fakeGithub({
    "https://api.github.com/user": { status: 200, body: { login: "octocat" } },
  });
  assert.equal(await verifyGithubIdentity("gho_good", fetchImpl), "octocat");
  assert.equal(seen[0]?.auth, "Bearer gho_good"); // the token is forwarded, not leaked elsewhere
});

test("verifyGithubIdentity returns null for a rejected token", async () => {
  const { fetchImpl } = fakeGithub({
    "https://api.github.com/user": { status: 401 },
  });
  assert.equal(await verifyGithubIdentity("gho_bad", fetchImpl), null);
});

test("authorizeUser is true when the user has push on a watched repo", async () => {
  const { fetchImpl } = fakeGithub({
    "https://api.github.com/repos/acme/web": { status: 200, body: { permissions: { push: true } } },
  });
  assert.equal(await authorizeUser("gho_good", ["acme/web"], fetchImpl), true);
});

test("authorizeUser is true if the user has push on ANY of several repos", async () => {
  const { fetchImpl } = fakeGithub({
    "https://api.github.com/repos/acme/web": { status: 200, body: { permissions: { push: false, pull: true } } },
    "https://api.github.com/repos/acme/api": { status: 200, body: { permissions: { admin: true } } },
  });
  assert.equal(await authorizeUser("gho_good", ["acme/web", "acme/api"], fetchImpl), true);
});

test("authorizeUser is false when the user only has read access", async () => {
  const { fetchImpl } = fakeGithub({
    "https://api.github.com/repos/acme/web": { status: 200, body: { permissions: { pull: true } } },
  });
  assert.equal(await authorizeUser("gho_good", ["acme/web"], fetchImpl), false);
});

test("authorizeUser is false when the user is not a collaborator (404)", async () => {
  const { fetchImpl } = fakeGithub({}); // every repo 404s
  assert.equal(await authorizeUser("gho_good", ["acme/web", "acme/api"], fetchImpl), false);
});

test("authorizeUser is false with no repos to authorize against", async () => {
  const { fetchImpl } = fakeGithub({});
  assert.equal(await authorizeUser("gho_good", [], fetchImpl), false);
});

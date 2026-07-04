// qa-engine/test/shared-infrastructure/code-graph/resolve-project-name.test.ts
//
// RED for Slice 4b (task 4b.6's project-resolution prerequisite, design §6, deferred 4a.10):
// resolveProjectName(client, repoDir) resolves the codebase-memory-mcp project name indexed for a
// given repoDir via `list_projects` — the CLI's own authoritative source (verified empirically:
// `codebase-memory-mcp cli list_projects '{}' <dir>` returns `{projects:[{name, root_path, ...}]}`,
// name derived as `root_path` with the leading '/' stripped and every remaining '/' replaced by
// '-'). Matches by root_path (not by re-deriving the name string) so a future indexer change to the
// derivation rule can never silently desync this resolver from the real CLI. Fail-open: no match,
// a malformed response, or a CLI failure (code:null) all resolve to undefined — NEVER a thrown
// error, matching CodeGraphUnavailable's own "no structural signal" contract at the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectName, ProjectNameResolver } from "../../../src/shared-infrastructure/code-graph/resolve-project-name.ts";

function fakeClient(stdout: string, code: number | null = 0) {
  const calls: Array<{ tool: string; jsonArg: string; repoDir: string }> = [];
  return {
    calls,
    client: {
      async cli(tool: string, jsonArg: string, repoDir: string) {
        calls.push({ tool, jsonArg, repoDir });
        return { code, stdout, stderr: "" };
      },
    },
  };
}

test("resolves the project name whose root_path matches repoDir exactly", async () => {
  const { client, calls } = fakeClient(
    JSON.stringify({
      projects: [
        { name: "Users-arielyumn-Desktop-TRABAJO-nname-ms-name-restaurants", root_path: "/Users/arielyumn/Desktop/TRABAJO/nname/ms-name-restaurants" },
        { name: "Users-arielyumn-Desktop-TRABAJO-nname-ms-name-orders", root_path: "/Users/arielyumn/Desktop/TRABAJO/nname/ms-name-orders" },
      ],
    }),
  );

  const name = await resolveProjectName(client, "/Users/arielyumn/Desktop/TRABAJO/nname/ms-name-restaurants");

  assert.equal(name, "Users-arielyumn-Desktop-TRABAJO-nname-ms-name-restaurants");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, "list_projects");
  assert.deepEqual(JSON.parse(calls[0]!.jsonArg), {}, "the jsonArg must be the literal empty-object STRING '{}', not an object literal");
});

test("no matching root_path resolves to undefined (fail-open — the unindexed-repo degrade)", async () => {
  const { client } = fakeClient(
    JSON.stringify({ projects: [{ name: "some-other-app", root_path: "/some/other/app" }] }),
  );

  const name = await resolveProjectName(client, "/Users/arielyumn/Desktop/TRABAJO/ai-pipeline");

  assert.equal(name, undefined);
});

test("a CLI failure (code:null) resolves to undefined, never throws", async () => {
  const { client } = fakeClient("", null);
  const name = await resolveProjectName(client, "/any/repo");
  assert.equal(name, undefined);
});

test("malformed JSON stdout resolves to undefined, never throws", async () => {
  const { client } = fakeClient("not json");
  const name = await resolveProjectName(client, "/any/repo");
  assert.equal(name, undefined);
});

test("a response missing the projects array resolves to undefined, never throws", async () => {
  const { client } = fakeClient(JSON.stringify({ nope: true }));
  const name = await resolveProjectName(client, "/any/repo");
  assert.equal(name, undefined);
});

test("the bare free function resolveProjectName never memoizes — every call re-invokes the CLI", async () => {
  const { client, calls } = fakeClient(
    JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  );

  await resolveProjectName(client, "/mirrors/org/app");
  await resolveProjectName(client, "/mirrors/org/app");

  assert.equal(calls.length, 2, "the free function has no memoization of its own — that is ProjectNameResolver's job");
});

test("ProjectNameResolver memoizes the resolution per repoDir — a second call for the SAME repoDir does not re-invoke the CLI", async () => {
  const { client, calls } = fakeClient(
    JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  );
  const resolver = new ProjectNameResolver(client);

  const first = await resolver.resolve("/mirrors/org/app");
  const second = await resolver.resolve("/mirrors/org/app");

  assert.equal(first, "org-app");
  assert.equal(second, "org-app");
  assert.equal(calls.length, 1, "the second call for the SAME repoDir must be served from the memoization cache, not re-invoke the CLI");
});

test("ProjectNameResolver does not memoize across DIFFERENT repoDirs", async () => {
  const { client, calls } = fakeClient(
    JSON.stringify({
      projects: [
        { name: "org-app-a", root_path: "/mirrors/org/app-a" },
        { name: "org-app-b", root_path: "/mirrors/org/app-b" },
      ],
    }),
  );
  const resolver = new ProjectNameResolver(client);

  const a = await resolver.resolve("/mirrors/org/app-a");
  const b = await resolver.resolve("/mirrors/org/app-b");

  assert.equal(a, "org-app-a");
  assert.equal(b, "org-app-b");
  assert.equal(calls.length, 2, "a different repoDir must trigger its own list_projects call");
});

test("ProjectNameResolver instances are independent — a fresh instance starts with an empty cache", async () => {
  const { client: clientA } = fakeClient(
    JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  );
  const { client: clientB, calls: callsB } = fakeClient(
    JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  );

  await new ProjectNameResolver(clientA).resolve("/mirrors/org/app");
  await new ProjectNameResolver(clientB).resolve("/mirrors/org/app");

  assert.equal(callsB.length, 1, "a fresh ProjectNameResolver instance must not inherit another instance's cache");
});

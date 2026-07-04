// qa-engine/test/shared-infrastructure/code-graph/lazy-project-code-graph.adapter.test.ts
//
// RED for Slice 4b.6's project-resolution prerequisite: LazyProjectCodeGraphAdapter wraps
// CodebaseMemoryCodeGraphAdapter's static `project` constructor arg with a per-call, memoized,
// fail-open resolution via ProjectNameResolver. This is what lets composition-root.ts construct the
// REAL CodeGraphPort chain WITHOUT knowing the indexed project name up front (it is only knowable by
// asking `list_projects` against the real repoDir, which is a per-run value the synchronous
// wireBridges() cannot await). An unresolvable repoDir (not indexed) degrades every query to ok([])
// — never an error, never a fabricated result — matching CodeGraphUnavailable's "no structural
// signal" contract, but WITHOUT ever invoking the underlying adapter with an empty-string project
// (which would silently misroute to whatever `project:""` might resolve to server-side).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LazyProjectCodeGraphAdapter } from "../../../src/shared-infrastructure/code-graph/lazy-project-code-graph.adapter.ts";
import { ProjectNameResolver } from "../../../src/shared-infrastructure/code-graph/resolve-project-name.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { isOk, isErr } from "@kernel/result.ts";

const changed = BlastRadius.of(Sha.of("abc1234"), ["src/Foo.java"]);

function fakeClient(overrides: { listProjects?: string; query?: string } = {}) {
  const calls: Array<{ tool: string; jsonArg: string; repoDir: string }> = [];
  return {
    calls,
    client: {
      async cli(tool: string, jsonArg: string, repoDir: string) {
        calls.push({ tool, jsonArg, repoDir });
        if (tool === "list_projects") {
          return { code: 0, stdout: overrides.listProjects ?? JSON.stringify({ projects: [] }), stderr: "" };
        }
        return { code: 0, stdout: overrides.query ?? JSON.stringify({ columns: [], rows: [], total: 0 }), stderr: "" };
      },
    },
  };
}

test("resolves the project name once and passes it to every query for a resolvable repoDir", async () => {
  const { client, calls } = fakeClient({
    listProjects: JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
    query: JSON.stringify({ columns: ["a_file", "a_name", "b_name", "b_file", "confidence"], rows: [], total: 0 }),
  });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  const result = await adapter.impactedSymbols("/mirrors/org/app", changed, { depth: 1 });

  assert.ok(isOk(result));
  const queryCall = calls.find((c) => c.tool === "query_graph");
  assert.ok(queryCall, "query_graph must have been invoked");
  const parsed = JSON.parse(queryCall!.jsonArg) as { project: string };
  assert.equal(parsed.project, "org-app", "the resolved project name must be threaded into the query_graph call");
});

test("an unresolvable repoDir (not indexed) degrades every structural method to ok([]), never a fabricated result or an error", async () => {
  const { client } = fakeClient({ listProjects: JSON.stringify({ projects: [] }) });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  const impacted = await adapter.impactedSymbols("/mirrors/unindexed/app", changed, { depth: 1 });
  const coupled = await adapter.coChangeCoupling("/mirrors/unindexed/app", ["src/Foo.java"]);
  const callers = await adapter.callersOf("/mirrors/unindexed/app", { file: "src/Foo.java", symbol: "run" }, 1);

  assert.ok(isOk(impacted) && impacted.value.length === 0, "impactedSymbols must degrade to ok([]) for an unindexed repo");
  assert.ok(isOk(coupled) && coupled.value.length === 0, "coChangeCoupling must degrade to ok([]) for an unindexed repo");
  assert.ok(isOk(callers) && callers.value.length === 0, "callersOf must degrade to ok([]) for an unindexed repo");
});

test("never invokes query_graph with an empty-string project when resolution fails", async () => {
  const { client, calls } = fakeClient({ listProjects: JSON.stringify({ projects: [] }) });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  await adapter.impactedSymbols("/mirrors/unindexed/app", changed, { depth: 1 });

  const queryCall = calls.find((c) => c.tool === "query_graph");
  assert.equal(queryCall, undefined, "query_graph must never be invoked when the project cannot be resolved — never a project:'' misroute");
});

test("resolution is memoized across multiple calls for the SAME repoDir via the shared resolver", async () => {
  const { client, calls } = fakeClient({
    listProjects: JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  await adapter.impactedSymbols("/mirrors/org/app", changed, { depth: 1 });
  await adapter.coChangeCoupling("/mirrors/org/app", ["src/Foo.java"]);

  const listProjectsCalls = calls.filter((c) => c.tool === "list_projects");
  assert.equal(listProjectsCalls.length, 1, "list_projects must only be spawned once across multiple method calls for the same repoDir");
});

test("existingCoverage and structurallyRelated stay inert (out of scope for this entire change, mirrors the underlying adapter)", async () => {
  const { client } = fakeClient({
    listProjects: JSON.stringify({ projects: [{ name: "org-app", root_path: "/mirrors/org/app" }] }),
  });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  const coverage = await adapter.existingCoverage("/mirrors/org/app", changed);
  const related = await adapter.structurallyRelated("/mirrors/org/app", [{ file: "src/Foo.java", symbol: "run" }]);

  assert.ok(isOk(coverage) && coverage.value.length === 0);
  assert.ok(isOk(related) && related.value.length === 0);
});

test("syncTo degrades to IndexFailed when the repo cannot be resolved to a project (never silently proceeds with an empty project)", async () => {
  const { client } = fakeClient({ listProjects: JSON.stringify({ projects: [] }) });
  const resolver = new ProjectNameResolver(client);
  const adapter = new LazyProjectCodeGraphAdapter(client, resolver);

  const result = await adapter.syncTo("/mirrors/unindexed/app", ["src/Foo.java"]);

  assert.ok(isErr(result), "syncTo must surface IndexFailed loudly (R11) rather than silently indexing under an empty project name");
});

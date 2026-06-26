// test/contexts/agent-runtime/infrastructure/role-assignment-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoleAssignmentResolverAdapter } from "@contexts/agent-runtime/infrastructure/role-assignment-resolver.ts";

test("resolve delegates to assignmentForRole for an explicit role", () => {
  let seenRole = "";
  const resolver = new RoleAssignmentResolverAdapter(
    { mode: "dual", assignments: {} } as never,
    (_cfg, role) => { seenRole = role; return { provider: "opencode", model: "m-primary" }; },
  );
  const a = resolver.resolve("primary");
  assert.equal(seenRole, "primary"); // DELEGATION: a gutted impl returning a literal FAILS this
  assert.equal(a.provider, "opencode");
});

test("a fallback role (worker) still resolves via the SAME injected fn — fallback preserved, not 'fixed'", () => {
  const calls: string[] = [];
  const resolver = new RoleAssignmentResolverAdapter(
    { mode: "single", assignments: {} } as never,
    (_cfg, role) => { calls.push(role); return { provider: "opencode", model: "m-fallback" }; },
  );
  resolver.resolve("worker");
  // The adapter MUST NOT pre-filter to "3 explicit roles" — it forwards EVERY role to assignmentForRole,
  // which owns the 3-explicit / 5-fallback policy. A resolver that rejects "worker" would regress it.
  assert.deepEqual(calls, ["worker"]);
});

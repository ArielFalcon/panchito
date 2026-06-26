// test/contexts/workspace-and-publication/infrastructure/shadow-log.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ShadowLogAdapter } from "@contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts";

test("openPr logs instead of making a real PR", async () => {
  const logged: string[] = [];
  const adapter = new ShadowLogAdapter((msg) => logged.push(msg));
  await adapter.openPr("org/app", "qa/e2e-abc", "Test title", "body");
  assert.ok(logged.length > 0);
  assert.ok(logged.some((l) => /shadow.*PR|PR.*shadow/i.test(l) || /openPr|open.*pr/i.test(l)));
});

test("openIssue logs instead of opening a real issue", async () => {
  const logged: string[] = [];
  const adapter = new ShadowLogAdapter((msg) => logged.push(msg));
  await adapter.openIssue("org/app", "E2E failed", "details");
  assert.ok(logged.length > 0);
  assert.ok(logged.some((l) => /shadow.*issue|issue.*shadow/i.test(l) || /openIssue|open.*issue/i.test(l)));
});

test("commit logs instead of staging and committing", async () => {
  const logged: string[] = [];
  const adapter = new ShadowLogAdapter((msg) => logged.push(msg));
  await adapter.commit("/m", "test(e2e): qa", ["e2e/a.spec.ts"]);
  assert.ok(logged.length > 0);
  assert.ok(logged.some((l) => /shadow.*commit|commit.*shadow/i.test(l) || /commit/i.test(l)));
});

test("push logs instead of pushing", async () => {
  const logged: string[] = [];
  const adapter = new ShadowLogAdapter((msg) => logged.push(msg));
  await adapter.push("/m", "qa/e2e-abc");
  assert.ok(logged.length > 0);
  assert.ok(logged.some((l) => /shadow.*push|push.*shadow/i.test(l) || /push/i.test(l)));
});

test("prune logs instead of pruning the mirror", async () => {
  const logged: string[] = [];
  const adapter = new ShadowLogAdapter((msg) => logged.push(msg));
  await adapter.prune("/mirrors/org-app");
  assert.ok(logged.length > 0);
  assert.ok(logged.some((l) => /shadow.*prune|prune.*shadow/i.test(l) || /prune/i.test(l)));
});

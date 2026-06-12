import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildOpenApiDocument, ARTIFACT_PATH } from "./openapi";
import { RunRecordSchema } from "./commands";

type Doc = {
  openapi: string;
  info: { version: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

test("the OpenAPI document is well-formed and exposes the v1 surface", () => {
  const doc = buildOpenApiDocument() as Doc;
  assert.equal(doc.openapi, "3.0.3");
  assert.ok(doc.info.version);
  for (const p of ["/api/v1/version", "/api/v1/runs", "/api/v1/runs/{id}", "/api/v1/runs/{id}/events", "/api/v1/queue", "/api/v1/apps", "/api/v1/apps/{name}", "/api/v1/repos", "/api/v1/agent/config", "/api/v1/agent/models", "/api/v1/agent/restart"]) {
    assert.ok(doc.paths[p], `missing path ${p}`);
  }
  for (const c of ["RunEvent", "RunRecord", "QaCase", "AppView", "QueueStatus", "VersionInfo", "CreateRunInput", "CreateAppInput", "UpdateAppInput", "CreateAppResult", "DeleteAppResult", "RepoListItem", "RepoListResponse", "PublicAgentConfig", "AgentConfigUpdate", "AgentConfigApplyResult"]) {
    assert.ok(doc.components.schemas[c], `missing component ${c}`);
  }
});

test("the OpenAPI document exposes app onboarding verbs for codegen clients", () => {
  const doc = buildOpenApiDocument() as Doc;
  const apps = doc.paths["/api/v1/apps"] as Record<string, unknown>;
  const app = doc.paths["/api/v1/apps/{name}"] as Record<string, unknown>;
  const repos = doc.paths["/api/v1/repos"] as Record<string, unknown>;
  assert.ok(apps.get, "missing GET /api/v1/apps");
  assert.ok(apps.post, "missing POST /api/v1/apps");
  assert.ok(app.get, "missing GET /api/v1/apps/{name}");
  assert.ok(app.put, "missing PUT /api/v1/apps/{name}");
  assert.ok(app.delete, "missing DELETE /api/v1/apps/{name}");
  assert.ok(repos.get, "missing GET /api/v1/repos");
});

test("nested entities are $ref'd, not inlined (codegen-friendly)", () => {
  const doc = buildOpenApiDocument() as Doc;
  const cases = doc.components.schemas.RunRecord?.properties?.cases;
  assert.deepEqual(cases, { type: "array", items: { $ref: "#/components/schemas/QaCase" } });
});

test("a real RunRecord shape validates against RunRecordSchema (runtime drift guard)", () => {
  const record = {
    id: "run_1", app: "portfolio", sha: "abc1234", target: "e2e", mode: "diff",
    status: "done", verdict: "pass", passed: 3, failed: 0,
    cases: [{ name: "login", status: "pass" }], logs: ["started", "done"],
    at: "2026-01-01T00:00:00.000Z",
  };
  assert.doesNotThrow(() => RunRecordSchema.parse(record));
});

test("contract/openapi.json is committed and up to date", () => {
  assert.ok(existsSync(ARTIFACT_PATH), "contract/openapi.json missing — run `npm run contract:gen`");
  const committed = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  assert.deepEqual(committed, buildOpenApiDocument(), "openapi.json is stale — run `npm run contract:gen`");
});

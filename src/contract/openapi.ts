// Emits the versioned OpenAPI 3.0 artifact (contract/openapi.json) from the zod
// schemas — the single source of truth. The Go client vendors this file and runs
// oapi-codegen over it (Phase E) to generate its structs + typed client, so the
// orchestrator and the client cannot drift. Uses zod 4's NATIVE JSON Schema
// export (no extra dependency); each registered schema becomes a
// #/components/schemas/<id> with $refs between them. See docs/tui-vnext.md §3.

import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunEventSchema, RunEventBodySchema } from "./events";
import {
  RunRecordSchema, QaCaseSchema, SpecRecordSchema, AgentActivitySchema,
  AppViewSchema, AppServiceViewSchema, QueueStatusSchema, ChatEntrySchema,
  CreateRunInputSchema, CreateRunResultSchema, AskRequestSchema, AskResponseSchema,
  ContinueRequestSchema, ContinueResultSchema,
} from "./commands";

export const API_VERSION = "1.0.0";

// Each entry becomes a top-level component the Go client codegens into a struct.
// Nested registered schemas are emitted as $refs; unregistered shapes inline.
const NAMED_SCHEMAS = {
  RunEvent: RunEventSchema,
  RunEventBody: RunEventBodySchema,
  RunRecord: RunRecordSchema,
  QaCase: QaCaseSchema,
  SpecRecord: SpecRecordSchema,
  AgentActivity: AgentActivitySchema,
  AppView: AppViewSchema,
  AppService: AppServiceViewSchema,
  QueueStatus: QueueStatusSchema,
  ChatEntry: ChatEntrySchema,
  CreateRunInput: CreateRunInputSchema,
  CreateRunResult: CreateRunResultSchema,
  AskRequest: AskRequestSchema,
  AskResponse: AskResponseSchema,
  ContinueRequest: ContinueRequestSchema,
  ContinueResult: ContinueResultSchema,
} as const;

function componentSchemas(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(NAMED_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: "openapi-3.0",
    uri: (id) => `#/components/schemas/${id}`,
  });
  // Strip the ref-path `$id` zod stamps on each root — OpenAPI components are
  // addressed by their map key, not a self `$id`.
  const out: Record<string, unknown> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    const { $id: _drop, ...rest } = schema as Record<string, unknown>;
    out[id] = rest;
  }
  return out;
}

const ref = (id: string): { $ref: string } => ({ $ref: `#/components/schemas/${id}` });
const jsonBody = (id: string): unknown => ({ "application/json": { schema: ref(id) } });
const jsonArray = (id: string): unknown => ({ "application/json": { schema: { type: "array", items: ref(id) } } });
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };

function paths(): Record<string, unknown> {
  return {
    "/api/v1/runs": {
      post: {
        operationId: "createRun", summary: "Enqueue a run",
        requestBody: { required: true, content: jsonBody("CreateRunInput") },
        responses: { "201": { description: "enqueued", content: jsonBody("CreateRunResult") } },
      },
      get: {
        operationId: "listRuns", summary: "List recent runs for an app",
        parameters: [
          { name: "app", in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "runs", content: jsonArray("RunRecord") } },
      },
    },
    "/api/v1/runs/{id}": {
      get: { operationId: "getRun", parameters: [idParam], responses: { "200": { description: "run", content: jsonBody("RunRecord") } } },
      delete: { operationId: "cancelRun", summary: "Cancel a run", parameters: [idParam], responses: { "204": { description: "cancelled" } } },
    },
    "/api/v1/runs/{id}/events": {
      get: {
        operationId: "streamRunEvents",
        summary: "SSE stream of RunEvents; Last-Event-ID resumes from the given seq",
        parameters: [idParam, { name: "Last-Event-ID", in: "header", schema: { type: "string" } }],
        responses: { "200": { description: "event stream", content: { "text/event-stream": { schema: ref("RunEvent") } } } },
      },
    },
    "/api/v1/runs/{id}/ask": {
      post: { operationId: "askRun", parameters: [idParam], requestBody: { required: true, content: jsonBody("AskRequest") }, responses: { "200": { description: "answer", content: jsonBody("AskResponse") } } },
    },
    "/api/v1/runs/{id}/continue": {
      post: { operationId: "continueRun", parameters: [idParam], requestBody: { required: true, content: jsonBody("ContinueRequest") }, responses: { "200": { description: "continuation", content: jsonBody("ContinueResult") } } },
    },
    "/api/v1/queue": { get: { operationId: "getQueue", responses: { "200": { description: "queue depth", content: jsonBody("QueueStatus") } } } },
    "/api/v1/apps": { get: { operationId: "listApps", responses: { "200": { description: "configured apps", content: jsonArray("AppView") } } } },
    "/api/v1/help": { post: { operationId: "help", requestBody: { required: true, content: jsonBody("AskRequest") }, responses: { "200": { description: "answer", content: jsonBody("AskResponse") } } } },
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Panchito Control Plane",
      version: API_VERSION,
      description:
        "The Channel Gateway contract: queued commands + the RunEvent SSE stream. " +
        "Source of truth: src/contract/*.ts (zod). GENERATED — do not edit by hand; run `npm run contract:gen`.",
    },
    paths: paths(),
    components: { schemas: componentSchemas() },
  };
}

export const ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contract", "openapi.json");

// Writes the artifact deterministically (stable key order via the builders above)
// so the committed file only changes when the schemas do.
export function writeOpenApiArtifact(path: string = ARTIFACT_PATH): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n", "utf8");
  return path;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunRecord as TypesRunRecord, QaCase as TypesQaCase } from "../types";
import {
  RunRecordSchema,
  QaCaseSchema,
  CreateRunInputSchema,
  CreateAppInputSchema,
  CreateAppResultSchema,
  DeleteAppResultSchema,
  QueueStatusSchema,
  RepoListResponseSchema,
  UpdateAppInputSchema,
  type RunRecord as ContractRunRecord,
  type QaCase as ContractQaCase,
} from "./commands";

// ── Compile-time drift guard ──────────────────────────────────────────────────
// The zod contract and src/types.ts must be MUTUALLY assignable. If a field is
// added, removed, or retyped on either side, `true` stops being assignable to the
// computed type and `npm run typecheck` fails. (Tuples avoid union distribution.)
type MutualAssign<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _runRecordInSync: MutualAssign<TypesRunRecord, ContractRunRecord> = true;
const _qaCaseInSync: MutualAssign<TypesQaCase, ContractQaCase> = true;
void _runRecordInSync;
void _qaCaseInSync;

test("QaCase parses a representative case; a bad status is rejected", () => {
  assert.doesNotThrow(() => QaCaseSchema.parse({ name: "login", status: "pass" }));
  assert.throws(() => QaCaseSchema.parse({ name: "login", status: "green" }));
});

test("CreateRunInput requires app/target/mode and rejects an unknown mode", () => {
  assert.doesNotThrow(() => CreateRunInputSchema.parse({ app: "portfolio", target: "e2e", mode: "diff" }));
  assert.throws(() => CreateRunInputSchema.parse({ app: "portfolio", target: "e2e" }));
  assert.throws(() => CreateRunInputSchema.parse({ app: "portfolio", target: "e2e", mode: "turbo" }));
});

test("QueueStatus.running is nullable", () => {
  assert.doesNotThrow(() => QueueStatusSchema.parse({ pending: 0, running: null }));
  assert.doesNotThrow(() => QueueStatusSchema.parse({ pending: 1, running: { id: "run_1", app: "portfolio" } }));
});

test("app onboarding command schemas parse create/update/delete/repo list payloads", () => {
  assert.doesNotThrow(() => CreateAppInputSchema.parse({
    repo: "org/shop",
    name: "shop",
    baseUrl: "https://dev.shop.test",
    target: "e2e",
    shadow: true,
    services: [{ repo: "org/api", openapi: "openapi.yaml" }],
    env: { DEV_TOKEN: "secret" },
    dryRun: true,
  }));
  assert.doesNotThrow(() => UpdateAppInputSchema.parse({
    baseUrl: "https://new.dev.shop.test",
    target: "code",
    shadow: false,
  }));
  assert.doesNotThrow(() => CreateAppResultSchema.parse({
    ok: true,
    name: "shop",
    path: "/config/apps/shop.yaml",
    repoInfo: { name: "shop", fullName: "org/shop", private: false, defaultBranch: "main", description: null },
    envApplied: ["DEV_TOKEN"],
    warnings: ["remember doppler"],
  }));
  assert.doesNotThrow(() => DeleteAppResultSchema.parse({ removed: ["config:shop"] }));
  assert.doesNotThrow(() => RepoListResponseSchema.parse({
    repos: [{ fullName: "org/shop", private: true, description: null }],
    hasMore: false,
  }));
});

test("a full RunRecord (every optional populated) parses", () => {
  const record: ContractRunRecord = {
    id: "run_1", app: "portfolio", sha: "abc1234", ref: "main", target: "e2e", mode: "diff",
    status: "done", step: "decide", stepDetail: "green", verdict: "pass", passed: 3, failed: 0,
    note: "ok", retrying: false, parentRunId: undefined, triggerRepo: undefined,
    cases: [{ name: "login", status: "pass" }], specs: [{ name: "login.spec.ts", flow: "login" }],
    logs: ["started", "done"], activity: [{ kind: "phase", text: "execute", ts: "2026-01-01T00:00:00.000Z" }],
    stepStartedAt: "2026-01-01T00:00:00.000Z", at: "2026-01-01T00:00:01.000Z",
  };
  assert.doesNotThrow(() => RunRecordSchema.parse(record));
});

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
  OnboardStateSchema,
  OnboardingJobStatusSchema,
  RepoIndexOutcomeSchema,
  ResolutionSummarySchema,
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

// ── Indexing phase (onboarding-auto-index, Slice 1, design §2.2, §2.7.1) ────────

test("OnboardStateSchema accepts the new 'indexing' member alongside every existing state", () => {
  for (const state of ["idle", "resolvingMirrors", "proposing", "scoring", "indexing", "done", "failed"]) {
    assert.doesNotThrow(() => OnboardStateSchema.parse(state));
  }
  assert.throws(() => OnboardStateSchema.parse("indexingXYZ"));
});

test("RepoIndexOutcomeSchema accepts ok/failed outcomes and rejects an invalid status", () => {
  assert.doesNotThrow(() => RepoIndexOutcomeSchema.parse({ repo: "org/shop", status: "ok", nodeCount: 42 }));
  assert.doesNotThrow(() => RepoIndexOutcomeSchema.parse({ repo: "org/shop-svc", status: "failed", error: "timed out" }));
  assert.throws(() => RepoIndexOutcomeSchema.parse({ repo: "org/shop", status: "pending" }));
});

test("OnboardingJobStatusSchema accepts state:'indexing' with a valid indexProgress array", () => {
  assert.doesNotThrow(() => OnboardingJobStatusSchema.parse({
    state: "indexing",
    app: "shop",
    round: 3,
    ceiling: 3,
    candidatesScored: 6,
    outcome: "winner",
    indexProgress: [
      { repo: "org/shop", status: "ok", nodeCount: 120 },
      { repo: "org/shop-svc", status: "failed", error: "timed out" },
    ],
  }));
});

test("OnboardingJobStatusSchema rejects an indexProgress entry with an invalid RepoIndexOutcome status", () => {
  assert.throws(() => OnboardingJobStatusSchema.parse({
    state: "indexing",
    round: 3,
    ceiling: 3,
    candidatesScored: 6,
    indexProgress: [{ repo: "org/shop", status: "pending" }],
  }));
});

// ── Resolution summary (Add-Project Wizard, Slice A Task A3) ────────────────────

test("OnboardingJobStatusSchema accepts a resolution summary", () => {
  const parsed = OnboardingJobStatusSchema.safeParse({
    state: "done", round: 1, ceiling: 3, candidatesScored: 1, outcome: "winner",
    resolution: { edges: [{ fromRepo: "org/web", toRepo: "org/svc-a", transport: "http", calls: 2 }], unresolved: 0, external: 1, drift: 0 },
  });
  assert.equal(parsed.success, true);
});

test("ResolutionSummarySchema rejects a BoundaryEdgeSummary entry with an invalid transport", () => {
  assert.doesNotThrow(() => ResolutionSummarySchema.parse({
    edges: [{ fromRepo: "org/web", toRepo: "org/svc-a", transport: "rpc", calls: 1 }],
    unresolved: 0,
    external: 0,
    drift: 0,
  }));
  assert.throws(() => ResolutionSummarySchema.parse({
    edges: [{ fromRepo: "org/web", toRepo: "org/svc-a", transport: "grpc", calls: 1 }],
    unresolved: 0,
    external: 0,
    drift: 0,
  }));
});

test("ResolutionSummarySchema rejects a payload missing drift (Slice A hardening: drift is required, mirroring unresolved/external)", () => {
  assert.throws(() => ResolutionSummarySchema.parse({
    edges: [],
    unresolved: 0,
    external: 0,
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

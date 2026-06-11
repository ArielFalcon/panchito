import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pruneMirrors,
  computeActiveRepoSlugs,
  repoSlug,
  PRUNE_MAX_AGE_MS,
  type MirrorEntry,
  type MirrorPruneDeps,
} from "./mirror-prune";

const NOW = 1_750_000_000_000;
const FRESH = NOW - 60_000; // touched a minute ago
const STALE = NOW - PRUNE_MAX_AGE_MS - 60_000; // a minute past the 7-day window

interface StubOverrides {
  entries?: MirrorEntry[];
  configured?: string[];
  active?: string[];
  remove?: (path: string) => void;
  directorySize?: (path: string) => number;
  listThrows?: boolean;
}

function makeDeps(overrides: StubOverrides = {}): {
  deps: MirrorPruneDeps;
  removed: string[];
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const removed: string[] = [];
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const deps: MirrorPruneDeps = {
    mirrorRoot: "/mirrors",
    listMirrorDirs: () => {
      if (overrides.listThrows) throw new Error("ENOENT");
      return overrides.entries ?? [];
    },
    remove: overrides.remove ?? ((path) => removed.push(path)),
    directorySize: overrides.directorySize ?? (() => 1024),
    configuredRepoSlugs: () => new Set(overrides.configured ?? []),
    activeRepoSlugs: () => new Set(overrides.active ?? []),
    now: () => NOW,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  };
  return { deps, removed, logs };
}

const entry = (name: string, mtimeMs: number): MirrorEntry => ({ name, path: `/mirrors/${name}`, mtimeMs });

test("orphan mirror (repo not in any app config) is deleted even when fresh", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("gone__repo", FRESH)],
    configured: ["kept__repo"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["gone__repo"]);
  assert.deepEqual(removed, ["/mirrors/gone__repo"]);
});

test("configured mirror older than 7 days is deleted (re-cloned next run)", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("team__app", STALE)],
    configured: ["team__app"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["team__app"]);
  assert.deepEqual(removed, ["/mirrors/team__app"]);
});

test("configured and fresh mirror is kept", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("team__app", FRESH)],
    configured: ["team__app"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(removed, []);
});

test("active-run guard: the running job's mirror is never deleted, orphaned or stale", () => {
  const { deps, removed } = makeDeps({
    entries: [
      entry("active__orphan", FRESH), // orphan, but active
      entry("active__stale", STALE), // configured but stale, and active
      entry("inactive__orphan", FRESH), // orphan, NOT active → deleted
    ],
    configured: ["active__stale"],
    active: ["active__orphan", "active__stale"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["inactive__orphan"]);
  assert.deepEqual(removed, ["/mirrors/inactive__orphan"]);
});

test("protected mirror names are never deleted", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("ai-pipeline-self", STALE)], // orphan AND stale — still protected
    configured: [],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(removed, []);
});

test("a failing delete is logged as a warning and does not stop the pass", () => {
  const removed: string[] = [];
  const { deps, logs } = makeDeps({
    entries: [entry("breaks__repo", FRESH), entry("ok__repo", FRESH)],
    configured: [],
    remove: (path) => {
      if (path.includes("breaks")) throw new Error("EBUSY");
      removed.push(path);
    },
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["ok__repo"]);
  assert.deepEqual(removed, ["/mirrors/ok__repo"]);
  assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("failed to delete")));
});

test("freedBytes sums the size of deleted mirrors only", () => {
  const sizes: Record<string, number> = { "/mirrors/a__a": 100, "/mirrors/b__b": 200, "/mirrors/c__c": 999 };
  const { deps } = makeDeps({
    entries: [entry("a__a", FRESH), entry("b__b", FRESH), entry("c__c", FRESH)],
    configured: ["c__c"], // kept — its size must not count
    directorySize: (path) => sizes[path] ?? 0,
  });
  const result = pruneMirrors(deps);
  assert.equal(result.freedBytes, 300);
});

test("an unreadable mirrors root logs a warning and prunes nothing", () => {
  const { deps, removed, logs } = makeDeps({ listThrows: true });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(removed, []);
  assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("could not read")));
});

test("a summary line is logged only when something was deleted", () => {
  const pruned = makeDeps({ entries: [entry("x__y", FRESH)], configured: [] });
  pruneMirrors(pruned.deps);
  assert.ok(pruned.logs.some((l) => l.level === "info" && l.message === "pruned old mirrors"));

  const noop = makeDeps({ entries: [entry("x__y", FRESH)], configured: ["x__y"] });
  pruneMirrors(noop.deps);
  assert.equal(noop.logs.length, 0);
});

// ── computeActiveRepoSlugs (the guard's inputs) ──────────────────────────────

test("computeActiveRepoSlugs covers the running record's repo and triggerRepo", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "front", triggerRepo: "team/service" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: (app) => (app === "front" ? "team/front" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["team__front", "team__service"]);
});

test("computeActiveRepoSlugs ignores a record that is not running", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "enqueued", app: "front" }),
    queueCurrentRunId: () => null,
    getRecord: () => undefined,
    repoForApp: () => "team/front",
  });
  assert.equal(slugs.size, 0);
});

test("computeActiveRepoSlugs falls back to the queue's run id when DB and queue disagree", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => undefined,
    queueCurrentRunId: () => "q1",
    getRecord: (id) => (id === "q1" ? { app: "other", triggerRepo: "svc/repo" } : undefined),
    repoForApp: (app) => (app === "other" ? "team/other" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["svc__repo", "team__other"]);
});

test("computeActiveRepoSlugs tolerates a missing app config (repoForApp undefined)", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "deleted-app", triggerRepo: "svc/repo" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: () => undefined,
  });
  assert.deepEqual([...slugs], ["svc__repo"]);
});

test("repoSlug mirrors repo-mirror.ts directory naming", () => {
  assert.equal(repoSlug("owner/repo"), "owner__repo");
});

// Mirror-cache pruning. The mirrors volume holds exactly ONE working copy per
// repo (named by its slug, see repo-mirror.ts), each with a full node_modules —
// so an offboarded app leaves an orphaned mirror behind forever, and a long-idle
// mirror pins disk for nothing. This module deletes:
//   (a) mirrors whose repo is no longer referenced by any configured app
//       (neither as the primary `repo` nor in `services[].repo`), and
//   (b) configured mirrors not modified for more than PRUNE_MAX_AGE_MS
//       (the next run simply re-clones — an accepted cost).
// It NEVER deletes a mirror belonging to the currently-running job, nor the
// protected self-maintenance mirror. All side effects are injected
// (MirrorPruneDeps) so every branch is unit-testable; defaultMirrorPruneDeps
// wires the real fs, config loader and run history.

import { join } from "node:path";
import { readdirSync, statSync, rmSync } from "node:fs";
import { loadAppConfig, listAppConfigs } from "../orchestrator/config-loader";
import { currentRun, getRecord } from "./history";
import { logJson } from "../integrations/logger";

export const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Mirrors that are never pruned (the maintainer's own working copy).
export const PROTECTED_MIRROR_NAMES = new Set(["panchito-self"]);

// Directory name of a repo's mirror under the mirrors root (see repo-mirror.ts).
export function repoSlug(repo: string): string {
  return repo.replaceAll("/", "__");
}

export interface MirrorEntry {
  name: string; // directory name (the repo slug)
  path: string; // absolute path
  mtimeMs: number; // last modification time
}

export interface MirrorPruneDeps {
  mirrorRoot: string;
  /** Directories under the mirrors root (non-directories excluded). May throw if the root is unreadable. */
  listMirrorDirs(root: string): MirrorEntry[];
  remove(path: string): void;
  directorySize(path: string): number;
  /** Slugs of every repo referenced by a configured app (`repo` + `services[].repo`). */
  configuredRepoSlugs(): Set<string>;
  /** Slugs of the repos the currently-running job is using — never deleted. */
  activeRepoSlugs(): Set<string>;
  now(): number;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
}

export interface MirrorPruneResult {
  deleted: string[]; // mirror names removed
  freedBytes: number;
}

export function pruneMirrors(deps: MirrorPruneDeps): MirrorPruneResult {
  let entries: MirrorEntry[];
  try {
    entries = deps.listMirrorDirs(deps.mirrorRoot);
  } catch {
    deps.log("warn", "pruneMirrors: could not read mirror directory", { mirrorRoot: deps.mirrorRoot });
    return { deleted: [], freedBytes: 0 };
  }

  const configured = deps.configuredRepoSlugs();
  const active = deps.activeRepoSlugs();
  const now = deps.now();

  const deleted: string[] = [];
  let freedBytes = 0;
  for (const entry of entries) {
    if (PROTECTED_MIRROR_NAMES.has(entry.name)) continue;
    if (active.has(entry.name)) continue; // never touch the running job's mirrors
    const isOrphan = !configured.has(entry.name);
    const isStale = now - entry.mtimeMs > PRUNE_MAX_AGE_MS;
    if (!isOrphan && !isStale) continue;
    try {
      const size = deps.directorySize(entry.path);
      deps.remove(entry.path);
      deleted.push(entry.name);
      freedBytes += size;
    } catch (err) {
      deps.log("warn", "pruneMirrors: failed to delete mirror", {
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deleted.length > 0) {
    deps.log("info", "pruned old mirrors", {
      deletedCount: deleted.length,
      deleted,
      freedBytes,
      freedMB: Math.round(freedBytes / 1024 / 1024),
    });
  }
  return { deleted, freedBytes };
}

// ── Active-run guard ─────────────────────────────────────────────────────────
// The repos a prune pass must never touch: those of the run history says is
// running, plus — defensively, since DB and queue can be momentarily out of
// sync — those of the run the queue says it is executing.

export interface ActiveRunLookups {
  /** The running/enqueued record from history (history.currentRun). */
  currentRun(): { id: string; status: string; app: string; triggerRepo?: string } | undefined;
  /** The run id the queue is executing right now (JobQueue.current). */
  queueCurrentRunId(): string | null;
  getRecord(id: string): { app: string; triggerRepo?: string } | undefined;
  /** Primary repo of an app's config, or undefined when the config is missing/malformed. */
  repoForApp(app: string): string | undefined;
}

export function computeActiveRepoSlugs(lookups: ActiveRunLookups): Set<string> {
  const slugs = new Set<string>();
  const add = (app: string, triggerRepo?: string) => {
    const repo = lookups.repoForApp(app);
    if (repo) slugs.add(repoSlug(repo));
    if (triggerRepo) slugs.add(repoSlug(triggerRepo));
  };
  const running = lookups.currentRun();
  if (running && running.status === "running") add(running.app, running.triggerRepo);
  const queueId = lookups.queueCurrentRunId();
  if (queueId && (!running || running.id !== queueId)) {
    const record = lookups.getRecord(queueId);
    if (record) add(record.app, record.triggerRepo);
  }
  return slugs;
}

// ── Real wiring ──────────────────────────────────────────────────────────────

export function getDirectorySize(dir: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          size += statSync(fullPath).size;
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  } catch {
    /* ignore unreadable directories */
  }
  return size;
}

// queueCurrentRunId is the only piece the module cannot reach itself (the
// JobQueue instance lives in index.ts), so the caller injects it.
export function defaultMirrorPruneDeps(queueCurrentRunId: () => string | null): MirrorPruneDeps {
  return {
    mirrorRoot: process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors"),
    listMirrorDirs: (root) => {
      const out: MirrorEntry[] = [];
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        try {
          const s = statSync(path);
          if (s.isDirectory()) out.push({ name, path, mtimeMs: s.mtimeMs });
        } catch {
          /* entry vanished mid-scan — skip */
        }
      }
      return out;
    },
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    directorySize: getDirectorySize,
    configuredRepoSlugs: () => {
      const slugs = new Set<string>();
      for (const app of listAppConfigs()) {
        slugs.add(repoSlug(app.repo));
        for (const svc of app.services ?? []) slugs.add(repoSlug(svc.repo));
      }
      return slugs;
    },
    activeRepoSlugs: () =>
      computeActiveRepoSlugs({
        currentRun,
        queueCurrentRunId,
        getRecord,
        repoForApp: (app) => {
          try {
            return loadAppConfig(app).repo;
          } catch {
            return undefined;
          }
        },
      }),
    now: () => Date.now(),
    log: logJson,
  };
}

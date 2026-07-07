// Persistent cache for the FE↔BE architecture map (e2e/.qa/context.json).
//
// The working-copy mirror is git-cleaned on every run, so a perfectly-good map built on a PRIOR run
// of the SAME sha is wiped and rebuilt by an agent (~195s, pure waste — worst in the shadow
// validation loop that re-runs one sha over and over). This persists the map in the qa-data volume,
// keyed by app, so a same-sha re-run restores it deterministically with NO agent call. Safe by
// construction: a miss / unreadable cache simply returns undefined and the caller rebuilds as today.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectureContext } from "./context";

function cacheDir(): string {
  const dir = join(process.env.PANCHITO_ROOT ?? process.cwd(), "data", "context-cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(app: string): string {
  // Same sanitization as the mirror dir key — an app name is operator-controlled but keep it filesystem-safe.
  return join(cacheDir(), `${app.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

export function saveContextCache(app: string, map: ArchitectureContext): void {
  try {
    writeFileSync(cachePath(app), JSON.stringify(map));
  } catch {
    /* best-effort: a cache write failure must never affect the run */
  }
}

export function loadContextCache(app: string): ArchitectureContext | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(app), "utf8")) as ArchitectureContext;
  } catch {
    return undefined; // no cache / unreadable → caller rebuilds
  }
}

// Safety-critical hot-swap of the orchestrator's OWN src/ after a VERIFIED maintainer
// fix. The brick-prevention model has three parts:
//
//   1. A pre-merge + pre-swap self-test gate (typecheck + tests) — done in index.ts:
//      a fix that fails its own gate is never merged or swapped.
//   2. This module performs the swap with a BACKUP (src.bak + package*.bak) and writes a
//      boot marker, so the swap is recoverable.
//   3. The repo-ROOT `boot-guard.mjs` (NOT under src/, so it is never swapped and always
//      runs intact BEFORE the app) reads the marker and, if the new code fails to boot
//      healthy MAX_BOOT_ATTEMPTS times, restores the backup. A bad fix therefore can
//      never leave the service in an unstartable, unfixable state.
//
// The marker contract here is mirrored (in plain JS) by boot-guard.mjs. Keep both in sync.
// fs is injected so the orchestration is unit-tested; the real fs ops are the boundary.

import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SWAP_MARKER_FILE = "pending-swap.json";
export const MAX_BOOT_ATTEMPTS = 3;

// Durable record of a promote that is IN FLIGHT (SELF-03). confirmSwapAfterBoot clears the swap
// marker BEFORE the (up-to-10-min) promote poll, so a crash during the poll would otherwise lose
// the promote entirely. This record, written before the poll and cleared after a terminal outcome,
// is re-driven on the next boot. Kept separate from the swap marker so it can survive the marker
// being cleared without arming a spurious boot-guard rollback.
export const PENDING_PROMOTE_FILE = "pending-promote.json";

export interface PendingPromote {
  promote: { repo: string; prNumber: number; nodeId: string };
  prUrl?: string;
  fix?: { prTitle?: string; changes?: string[]; rootCause?: string };
  at: string;
}

export function writePendingPromote(dataDir: string, p: PendingPromote): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, PENDING_PROMOTE_FILE), JSON.stringify(p));
}

export function readPendingPromote(dataDir: string): PendingPromote | null {
  const path = join(dataDir, PENDING_PROMOTE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PendingPromote;
  } catch {
    return null;
  }
}

export function clearPendingPromote(dataDir: string): void {
  rmSync(join(dataDir, PENDING_PROMOTE_FILE), { force: true });
}

export interface SwapMarker {
  at: string;
  attempt: number;
  prUrl?: string;
  // "Promote-after-canary": the swapped-in code is a fix branch that has NOT yet been merged
  // to main. Once it boots healthy in production (the canary), index.ts merges this PR — so
  // main only ever receives code already proven to run. Absent for a plain (already-merged)
  // swap. If the canary fails, the boot-guard rolls back and the PR is simply never merged.
  promote?: { repo: string; prNumber: number; nodeId: string };
  // Compact description of the fix being deployed, so a rollback (here or in boot-guard.mjs)
  // can record WHAT failed into the maintainer's failure memory for the agent to learn from.
  fix?: { prTitle?: string; changes?: string[]; rootCause?: string };
}

export interface SwapFs {
  exists(p: string): boolean;
  rm(p: string): void;
  cp(from: string, to: string): void;
  readMarker(p: string): SwapMarker | null;
  writeMarker(p: string, m: SwapMarker): void;
  removeMarker(p: string): void;
}

export const realSwapFs: SwapFs = {
  exists: existsSync,
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  cp: (from, to) => cpSync(from, to, { recursive: true, force: true }),
  readMarker: (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as SwapMarker;
    } catch {
      return null;
    }
  },
  writeMarker: (p, m) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(m));
  },
  removeMarker: (p) => rmSync(p, { force: true }),
};

// Stage the new code over the live tree, keeping a backup for rollback, and write the
// boot-swap marker (attempt 0). If this throws mid-way the backup remains and the
// boot-guard rolls back after repeated failed boots.
export function performSwap(
  appDir: string,
  sourceDir: string,
  dataDir: string,
  opts: {
    at: string;
    prUrl?: string;
    promote?: { repo: string; prNumber: number; nodeId: string };
    fix?: { prTitle?: string; changes?: string[]; rootCause?: string };
  },
  fs: SwapFs = realSwapFs,
): void {
  const liveSrc = join(appDir, "src");
  const srcBak = join(appDir, "src.bak");
  const pkg = "package.json";
  const lock = "package-lock.json";

  // 1. Arm the boot-guard BEFORE any destructive operation. If the process crashes
  //    mid-swap, the marker exists → boot-guard.mjs detects it and can roll back.
  //    Without this, a crash after `rm(src)` but before the marker leaves src/ absent
  //    with no recovery armed → unbootable loop.
  const markerPath = join(dataDir, SWAP_MARKER_FILE);
  const marker: SwapMarker = { at: opts.at, attempt: 0, prUrl: opts.prUrl, promote: opts.promote, fix: opts.fix };
  fs.writeMarker(markerPath, marker);

  // Cleanup used when a failure happens BEFORE the live tree is destroyed: the marker would
  // otherwise leak and boot-guard could roll back a tree that was never swapped (the dev
  // bind-mount EBUSY case — fs ops throw but src/ stays intact). Best-effort.
  const unwind = () => {
    try { fs.removeMarker(markerPath); } catch { /* best-effort */ }
    for (const b of [srcBak, join(appDir, `${pkg}.bak`), join(appDir, `${lock}.bak`)]) {
      try { if (fs.exists(b)) fs.rm(b); } catch { /* best-effort */ }
    }
  };

  // 2. Backup the currently-running (known-good) tree. src/ is still intact here, so a failure
  //    needs no recovery → unwind the marker rather than leaking it.
  try {
    if (fs.exists(srcBak)) fs.rm(srcBak);
    fs.cp(liveSrc, srcBak);
    fs.cp(join(appDir, pkg), join(appDir, `${pkg}.bak`));
    if (fs.exists(join(appDir, lock))) fs.cp(join(appDir, lock), join(appDir, `${lock}.bak`));
  } catch (err) {
    unwind();
    throw err;
  }

  // 3a. Remove the live src. If THIS throws (e.g. EBUSY on a bind-mounted dev src/), the tree
  //     is still intact → unwind the marker so no spurious rollback is armed.
  try {
    fs.rm(liveSrc);
  } catch (err) {
    unwind();
    throw err;
  }

  // 3b. POINT OF NO RETURN: src/ is now gone. A failure from here MUST leave the marker armed so
  //     boot-guard.mjs can restore src.bak after repeated failed boots.
  fs.cp(join(sourceDir, "src"), liveSrc);
  fs.cp(join(sourceDir, pkg), join(appDir, pkg));
  if (fs.exists(join(sourceDir, lock))) fs.cp(join(sourceDir, lock), join(appDir, lock));
}

// Clear swap state once the new code is confirmed healthy after restart (removes marker
// and backups). Called from index.ts after a successful post-restart health check.
export function confirmSwapHealthy(appDir: string, dataDir: string, fs: SwapFs = realSwapFs): void {
  fs.removeMarker(join(dataDir, SWAP_MARKER_FILE));
  for (const b of ["src.bak", "package.json.bak", "package-lock.json.bak"]) {
    const p = join(appDir, b);
    if (fs.exists(p)) fs.rm(p);
  }
}

// Pure boot-guard decision shared with boot-guard.mjs: given the marker read at boot,
// decide whether to do nothing, count this boot as an attempt, or roll back.
export function bootGuardDecision(
  marker: SwapMarker | null,
): { action: "none" } | { action: "increment"; next: SwapMarker } | { action: "rollback" } {
  if (!marker) return { action: "none" };
  if (marker.attempt >= MAX_BOOT_ATTEMPTS) return { action: "rollback" };
  return { action: "increment", next: { ...marker, attempt: marker.attempt + 1 } };
}

// Restore the backup over the live tree (rollback). Used by the boot-guard and on a
// failed post-restart health check.
export function rollback(appDir: string, dataDir: string, fs: SwapFs = realSwapFs): boolean {
  const srcBak = join(appDir, "src.bak");
  if (!fs.exists(srcBak)) return false;
  fs.rm(join(appDir, "src"));
  fs.cp(srcBak, join(appDir, "src"));
  for (const f of ["package.json", "package-lock.json"]) {
    const bak = join(appDir, `${f}.bak`);
    if (fs.exists(bak)) fs.cp(bak, join(appDir, f));
  }
  confirmSwapHealthy(appDir, dataDir, fs); // clears marker + baks
  return true;
}

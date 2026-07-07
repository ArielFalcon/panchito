#!/usr/bin/env node
// ROOT-LEVEL boot guard. It runs BEFORE the app (see package.json "start") and is
// deliberately NOT part of src/, so a maintainer hot-swap never replaces it — it always
// runs intact and can roll back a bad swap. Mirrors the marker contract in
// src/server/self-update.ts (keep both in sync).
//
// Marker (data/pending-swap.json): { at, attempt, prUrl }. After a swap, attempt starts
// at 0. Each boot increments it; if the swapped code comes up healthy, index.ts clears
// the marker. If it fails to boot healthy MAX_BOOT_ATTEMPTS times, this guard restores
// the backed-up src/ (+ package files) so the service returns to the last known-good code.

import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.env.PANCHITO_ROOT ?? process.cwd();
const MARKER = join(ROOT, "data", "pending-swap.json");
const MAX_BOOT_ATTEMPTS = 3;

function readMarker() {
  try {
    return JSON.parse(readFileSync(MARKER, "utf8"));
  } catch {
    return null;
  }
}

const marker = readMarker();
if (!marker) process.exit(0); // normal boot, no pending swap

if ((marker.attempt ?? 0) >= MAX_BOOT_ATTEMPTS) {
  // The swapped code failed to come up healthy repeatedly → roll back to the backup.
  const srcBak = join(ROOT, "src.bak");
  if (existsSync(srcBak)) {
    rmSync(join(ROOT, "src"), { recursive: true, force: true });
    cpSync(srcBak, join(ROOT, "src"), { recursive: true });
    let packagesRestored = false;
    for (const f of ["package.json", "package-lock.json"]) {
      const bak = join(ROOT, `${f}.bak`);
      if (existsSync(bak)) {
        cpSync(bak, join(ROOT, f), { force: true });
        packagesRestored = true;
      }
    }
    for (const b of ["src.bak", "package.json.bak", "package-lock.json.bak"]) {
      rmSync(join(ROOT, b), { recursive: true, force: true });
    }
    // The swap already installed the NEW package set into node_modules; the restored code on
    // mutated deps could crash-loop with no recovery left. Reinstall the restored lockfile.
    if (packagesRestored) {
      try {
        execSync("npm install --no-audit --no-fund", { cwd: ROOT, stdio: "inherit", timeout: 10 * 60 * 1000 });
      } catch (err) {
        console.error(`[boot-guard] WARNING: npm install after rollback failed (${err?.message ?? err}) — the restored code may not boot until deps are reinstalled manually.`);
      }
    }
    console.error(`[boot-guard] swapped code failed ${marker.attempt} boot(s) — ROLLED BACK to the previous src/.`);
    // Bridge: the boot-guard can't use the app's modules, so it leaves the marker for the (now
    // restored, good) app to fold into the maintainer's failure memory on its next boot — so the
    // agent learns the fix crash-looped and won't try the same thing again.
    try {
      writeFileSync(join(ROOT, "data", "last-rollback.json"), JSON.stringify({ ...marker, reason: "boot-crash-loop" }));
    } catch {
      /* best effort */
    }
  }
  rmSync(MARKER, { force: true });
  process.exit(0);
}

// Count this boot as an attempt. If the app comes up healthy, index.ts clears the marker.
try {
  writeFileSync(MARKER, JSON.stringify({ ...marker, attempt: (marker.attempt ?? 0) + 1 }));
} catch {
  /* best effort */
}
console.error(`[boot-guard] pending swap — boot attempt ${(marker.attempt ?? 0) + 1}/${MAX_BOOT_ATTEMPTS}.`);
process.exit(0);

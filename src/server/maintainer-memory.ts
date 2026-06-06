// Persistent memory of maintainer fixes that FAILED (rolled back, failed their gate, or failed
// CI). It lives on the data volume (survives the hot-swap restart) and is injected into the next
// maintainer prompt so the agent does not repeat a fix that already broke the service for the
// same reason. This is the feedback loop that stops the system from breaking again and again the
// same way. fs is injectable so the logic is unit-tested; the real file op is the boundary.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type FixFailureReason =
  | "pre-deploy-gate" // typecheck/test failed before deploy
  | "canary-unhealthy" // booted but did not serve → rolled back
  | "boot-crash-loop" // failed to boot MAX_BOOT_ATTEMPTS → boot-guard rolled back
  | "ci-failed" // canary healthy but the required CI check on main went red
  | "ci-timeout"; // CI did not complete in time

export interface FixFailure {
  at: string;
  reason: FixFailureReason;
  prTitle?: string;
  prUrl?: string;
  changes?: string[];
  rootCause?: string; // the justification the agent gave, so it can see what it BELIEVED and why it was wrong
  detail?: string;
}

export interface MemoryFs {
  read(p: string): string | null;
  write(p: string, s: string): void;
  remove(p: string): void;
}

export const realMemoryFs: MemoryFs = {
  read: (p) => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  },
  write: (p, s) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s);
  },
  remove: (p) => rmSync(p, { force: true }),
};

export function readFixFailures(path: string, fs: MemoryFs = realMemoryFs): FixFailure[] {
  const raw = fs.read(path);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as FixFailure[]) : [];
  } catch {
    return [];
  }
}

export function recordFixFailure(path: string, failure: FixFailure, fs: MemoryFs = realMemoryFs, keep = 20): void {
  const all = readFixFailures(path, fs);
  all.push(failure);
  fs.write(path, JSON.stringify(all.slice(-keep)));
}

// Render the most recent failures as a prompt section the maintainer must read before fixing,
// so it avoids repeating a known-bad change. Empty string when there is nothing to warn about.
export function renderFailureMemory(failures: FixFailure[], max = 5): string {
  if (failures.length === 0) return "";
  const recent = failures.slice(-max).reverse();
  const lines = [
    "## Past fix attempts that FAILED — do NOT repeat these mistakes",
    "Each of these was deployed (or attempted) and rolled back / rejected. Learn from them:",
    "",
  ];
  for (const f of recent) {
    lines.push(`### ${f.at} — failed (${f.reason})`);
    if (f.prTitle) lines.push(`- Attempted fix: ${f.prTitle}`);
    if (f.rootCause) lines.push(`- It assumed the root cause was: ${f.rootCause}`);
    if (f.changes && f.changes.length) lines.push(`- It changed: ${f.changes.join("; ")}`);
    if (f.detail) lines.push(`- Why it failed: ${f.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}

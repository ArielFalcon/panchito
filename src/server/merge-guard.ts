// Validation + safety layers gating the maintainer's autonomous self-merge.
//
// A self-modifying service has one catastrophic failure mode: it ships a change that
// breaks itself AND removes its own ability to recover — an irrecoverable state. Every
// decision in this module is a PURE, unit-tested gate; the irreversible actions (hot-swap,
// merge) are taken in index.ts ONLY after every gate here returns ok. Together with the
// "canary before promote" flow (swap the fix into the running service and prove it healthy
// BEFORE merging it to main) and the boot-guard rollback net, the guarantees are:
//
//   - the recovery net itself (boot-guard, self-update, this module) can never be rewritten
//     by an autonomous fix → a rollback is always possible (scope guard);
//   - an over-large / unscoped rewrite is never auto-deployed (size guard);
//   - a fix that doesn't fix cannot loop the system into endless self-modification (rate guard);
//   - main only ever receives code that has already booted healthy in production, so a fresh
//     container always clones a known-good main (canary-before-promote, in index.ts).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Files whose modification must ALWAYS go through a human. Four groups:
//  1. The recovery net — if a fix could rewrite these, a bad change could disable the very
//     mechanism that rolls it back (the irrecoverable state we forbid).
//  2. The secret boundary — what scrubs data leaving the system; a fix must never weaken it.
//  3. The gate integrity surface — the maintainer's OWN pre-deploy gate is `npm test` +
//     `npm run typecheck`. If a fix could edit the test suite or the tsconfig, a BROKEN fix could
//     make itself "pass" by weakening the very gate that is supposed to reject it. The entrypoint
//     (index.ts) sequences the safety layers + the canary swap, and code-execution.runner.ts/
//     code-setup.ts/sandbox.ts (migration-tier-4b Slice 1 — the qa-engine home that replaced
//     src/qa/code-runner.ts) execute untrusted (agent-authored) code; an autonomous rewrite of
//     either is too dangerous to ship unreviewed. A fix that legitimately needs to touch these is
//     significant enough for a human.
//  4. Build/topology the in-process canary cannot verify — the hot-swap only replaces src/ +
//     package files; a Dockerfile/compose change takes effect only on an image rebuild, so
//     the canary would pass while the real effect ships unverified.
//
// A leading "*" is a suffix glob (e.g. "*.test.ts" matches any test file anywhere); a trailing
// "/" is a directory prefix; otherwise the entry is an exact repo-relative path.
export const PROTECTED_PATHS: string[] = [
  // 1. recovery net
  "boot-guard.mjs",
  "src/server/self-update.ts",
  "src/server/merge-guard.ts",
  // 2. secret boundary
  // sdd/migration-wiring-phase-2 Slice 7d: src/util/redact.ts is deleted — every consumer migrated
  // to the canonical RedactionPortAdapter (src/orchestrator/sanitizer.ts), the one remaining entry.
  "src/orchestrator/sanitizer.ts",
  // migration-tier-4b: every scrubEnv consumer (untrusted code-execution spawns, execute.ts,
  // maintainer-runtime.ts, and others) converged on this file — it holds BLOCKED_ENV_PREFIX/
  // ALLOWED_ENV_EXACT/ALLOWED_ENV_PREFIX, the secret-leak allowlist for untrusted spawns. An
  // unreviewed autonomous widening of this allowlist is exactly the failure mode this group exists
  // to prevent.
  "qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts",
  // sdd/security-hardening Slice 2: closes a real gap — these four were absent (grep-confirmed)
  // despite being squarely inside the secret/confinement boundary this group protects.
  // The write-confinement DOMAIN service — the SOLE implementation of CONFINEMENT_DENYLIST plus the
  // classify/revert logic (isCodeDenied/isE2eStray/classifyStrays). An unreviewed fix could silently
  // narrow the denylist or corrupt revert semantics.
  "qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts",
  // The write-confinement EFFECTFUL adapter — actually runs the git restore/clean revert this
  // domain service decides on. Equally load-bearing; the domain service alone deciding correctly
  // is meaningless if this adapter's git calls are weakened.
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts",
  // The composition root — wires RedactionPortAdapter, WriteConfinementAdapter, VcsWriteAdapter,
  // CODE_PUBLISH_EXCLUDES, and every GitHub adapter. An autonomous edit here can rewire ANY security
  // port to a weaker (or fake) implementation without ever touching the port/adapter files
  // themselves — the single widest-blast-radius file in the whole security surface.
  "src/server/rewritten-engine-factory.ts",
  // The canonical REDACTED placeholder + SecretLeakError, consumed by BOTH sanitizer twins
  // (src/orchestrator/sanitizer.ts here and qa-engine's own sanitize-text.ts below) — a fix here
  // weakens redaction for the WHOLE system from one shared-kernel seam.
  "qa-engine/src/shared-kernel/ports/redaction.port.ts",
  // The qa-engine-side model-prompt sanitizer twin (diff/commit-body/reviewer-text → model prompts).
  // CLAUDE.md names it explicitly as the canonical egress sanitizer for this boundary; it must stay
  // in lockstep with src/orchestrator/sanitizer.ts, not silently diverge via an autonomous edit.
  "qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts",
  // The logs→Issue containsSecret fail-loud call site — an autonomous fix could remove the guard
  // that refuses to ship a secret-carrying Issue body.
  "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts",
  // 3. gate integrity (the fix must not weaken what decides whether it deploys)
  "*.test.ts",
  "tsconfig.json",
  "src/index.ts",
  // migration-tier-4b Slice 1: src/qa/code-runner.ts is deleted — replaced by these three qa-engine
  // homes (the design's gate CORRECTION 3: the exact new paths, not a single literal).
  "qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts",
  // migration-tier-4d Slice 1b: src/qa/execute.ts is deleted — replaced by this qa-engine home. It
  // spawns agent-authored specs (untrusted) exactly like code-execution.runner.ts above, and was NOT
  // protected before this slice — a real pre-existing gap this migration closes, not just parity.
  "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts",
  // 4. build/topology the canary cannot verify (image rebuild only)
  ".github/",
  "Dockerfile",
  "agents/Dockerfile",
  "docker-compose.yml",
  "docker-compose.override.yml",
  "package.json",
  "package-lock.json",
];

export function isProtectedPath(file: string): boolean {
  const f = file.replace(/^\.\//, "").replace(/\\/g, "/");
  return PROTECTED_PATHS.some((p) => {
    if (p.startsWith("*")) return f.endsWith(p.slice(1)); // suffix glob, e.g. *.test.ts
    if (p.endsWith("/")) return f.startsWith(p); // directory prefix
    return f === p; // exact repo-relative path
  });
}

export interface ChangeStat {
  files: string[];
  additions: number;
  deletions: number;
}

export interface ChangeLimits {
  maxFiles: number;
  maxLines: number; // additions + deletions
}

// A maintainer fix is meant to be a small, targeted repair. Anything larger is, by
// definition, not a "minimal safe fix" and is left for a human.
export const DEFAULT_CHANGE_LIMITS: ChangeLimits = { maxFiles: 15, maxLines: 400 };

export interface GateResult {
  ok: boolean;
  reasons: string[]; // human-readable reasons it was blocked (empty when ok)
}

// Scope guard (protected paths) + size guard, combined: the fix must be minimal and must
// not touch the recovery net or unverifiable build/topology.
export function assessChange(stat: ChangeStat, limits: ChangeLimits = DEFAULT_CHANGE_LIMITS): GateResult {
  const reasons: string[] = [];
  if (stat.files.length === 0) reasons.push("the fix changed no files");
  const protectedTouched = stat.files.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
    reasons.push(`touches protected recovery/build files (human review required): ${protectedTouched.join(", ")}`);
  }
  if (stat.files.length > limits.maxFiles) {
    reasons.push(`changes ${stat.files.length} files, over the ${limits.maxFiles}-file limit for an autonomous fix`);
  }
  const lines = stat.additions + stat.deletions;
  if (lines > limits.maxLines) {
    reasons.push(`changes ${lines} lines, over the ${limits.maxLines}-line limit for an autonomous fix`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Parse `git diff --numstat` output into a ChangeStat. Binary files report "-" for the
// counts; treat those as 0 lines (the file still counts toward the file limit).
export function parseNumstat(out: string): ChangeStat {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [add, del, ...rest] = parts;
    files.push(rest.join("\t"));
    additions += add === "-" ? 0 : Number(add) || 0;
    deletions += del === "-" ? 0 : Number(del) || 0;
  }
  return { files, additions, deletions };
}

export interface RateLimits {
  maxInWindow: number; // max autonomous deploys per window
  windowMs: number;
  cooldownMs: number; // minimum gap between two deploys
}

// Conservative defaults: at most a few self-deploys per hour, never two within five minutes.
// A genuine incident is rare; a burst means a fix that isn't fixing — stop and ask a human.
export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxInWindow: 3,
  windowMs: 60 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
};

// Loop / rate guard: caps autonomous deploys in a sliding window and enforces a cooldown.
export function assessRate(history: number[], now: number, limits: RateLimits = DEFAULT_RATE_LIMITS): GateResult {
  const reasons: string[] = [];
  const recent = history.filter((t) => now - t >= 0 && now - t < limits.windowMs);
  if (recent.length >= limits.maxInWindow) {
    reasons.push(`${recent.length} autonomous deploy(s) in the last ${Math.round(limits.windowMs / 60000)}min (limit ${limits.maxInWindow}) — possible self-modification loop`);
  }
  const last = history.length ? Math.max(...history) : Number.NEGATIVE_INFINITY;
  if (now - last < limits.cooldownMs) {
    reasons.push(`last autonomous deploy was ${Math.round((now - last) / 1000)}s ago (cooldown ${Math.round(limits.cooldownMs / 1000)}s)`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Persisted deploy ledger (data/maintainer-deploys.json). It MUST survive restarts, because
// a hot-swap restarts the process — without persistence the rate guard would reset every time
// it deploys, defeating the loop protection. fs is injectable so the logic is unit-tested.
export interface LedgerFs {
  read(p: string): string | null;
  write(p: string, s: string): void;
}

export const realLedgerFs: LedgerFs = {
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
};

export function readDeployHistory(path: string, fs: LedgerFs = realLedgerFs): number[] {
  const raw = fs.read(path);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function recordDeploy(path: string, now: number, fs: LedgerFs = realLedgerFs, keep = 50): void {
  const hist = readDeployHistory(path, fs);
  hist.push(now);
  fs.write(path, JSON.stringify(hist.slice(-keep)));
}

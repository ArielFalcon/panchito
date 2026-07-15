import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProtectedPath,
  assessChange,
  parseNumstat,
  assessRate,
  readDeployHistory,
  recordDeploy,
  LedgerFs,
  DEFAULT_RATE_LIMITS,
  SECURITY_SENSITIVE_SURFACE_ROOTS,
  NOT_SECURITY_SENSITIVE,
} from "./merge-guard";

test("isProtectedPath flags the recovery net and build/topology, exact and prefix", () => {
  // exact-match protected files
  assert.equal(isProtectedPath("boot-guard.mjs"), true);
  assert.equal(isProtectedPath("src/server/self-update.ts"), true);
  assert.equal(isProtectedPath("src/server/merge-guard.ts"), true);
  assert.equal(isProtectedPath("docker-compose.yml"), true);
  assert.equal(isProtectedPath("./Dockerfile"), true); // leading ./ normalized
  // prefix-match (.github/ directory)
  assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
  // ordinary source is NOT protected — the maintainer may fix it autonomously
  assert.equal(isProtectedPath("src/pipeline.ts"), false);
  assert.equal(isProtectedPath("src/server/api.ts"), false);
});

test("isProtectedPath flags the secret boundary (a fix must never weaken what scrubs data leaving the system)", () => {
  assert.equal(isProtectedPath("src/orchestrator/sanitizer.ts"), true);
  // the untrusted-spawn secret allowlist (BLOCKED_ENV_PREFIX/ALLOWED_ENV_EXACT/ALLOWED_ENV_PREFIX) —
  // every scrubEnv consumer converged on this file; widening it unreviewed would leak secrets to
  // agent-authored code.
  assert.equal(isProtectedPath("qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts"), true);
  // SECURITY CRITICAL (verified by grep — absent before this fix): the write-confinement domain
  // service is now the SOLE implementation of CONFINEMENT_DENYLIST + the classify/revert logic; an
  // unreviewed autonomous "fix" here could silently narrow the denylist or break revert semantics.
  assert.equal(isProtectedPath("qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts"), true);
  // the composition root — wires RedactionPortAdapter, WriteConfinementAdapter, VcsWriteAdapter,
  // CODE_PUBLISH_EXCLUDES, and every GitHub adapter. An autonomous edit here can rewire ANY
  // security port to a weaker (or fake) implementation without touching the port/adapter files
  // themselves.
  assert.equal(isProtectedPath("src/server/rewritten-engine-factory.ts"), true);
  // the canonical REDACTED placeholder + SecretLeakError, consumed by BOTH sanitizer twins
  // (src/orchestrator/sanitizer.ts and qa-engine's sanitize-text.ts) — a fix could weaken redaction
  // for the whole system from this single shared-kernel seam.
  assert.equal(isProtectedPath("qa-engine/src/shared-kernel/ports/redaction.port.ts"), true);
  // the logs→Issue containsSecret fail-loud call site — an autonomous fix could remove the guard
  // that refuses to ship a secret-carrying Issue body.
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts"), true);
});

// judgment-day round 2 (FIX 6, both judges): the PRIOR version of this test used a basename-prefix
// heuristic (SENSITIVE_BASENAME_PREFIXES) as a stand-in for completeness — Judge B planted
// `secret-guard.service.ts` and Judge A planted `secrets.ts`/`confine.ts`/`egress.ts`, all inside
// workspace-and-publication/domain/, and it stayed GREEN (none of those names matched a known
// prefix). It IS a real regression gate for known naming patterns (verified: `sanitize-paths.ts`
// still fails it correctly), but its own "closes the reactive-growth gap" framing overstated it —
// this is defect #3 of the meta-lesson (an enumeration replacing an enumeration).
//
// Fixed by INVERTING the default instead of enumerating better: every file under
// SECURITY_SENSITIVE_SURFACE_ROOTS must be either in PROTECTED_PATHS or in the explicit, reviewed
// NOT_SECURITY_SENSITIVE allowlist — a NEW file forces a decision regardless of what it is named.
test("PROTECTED_PATHS completeness (FIX 6, invert-the-default): every file under the security-sensitive surface is either protected or explicitly reviewed as not-sensitive", async () => {
  const { readdirSync, statSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const repoRoot = join(import.meta.dirname, "..", "..");
  const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".claude", ".stryker-tmp"]);

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (st.isFile()) out.push(full);
    }
  }

  function unclassified(): string[] {
    const files: string[] = [];
    for (const root of SECURITY_SENSITIVE_SURFACE_ROOTS) {
      const abs = join(repoRoot, root);
      if (existsSync(abs)) walk(abs, files);
    }
    const bad: string[] = [];
    for (const full of files) {
      const rel = relative(repoRoot, full).replace(/\\/g, "/");
      if (!isProtectedPath(rel) && !NOT_SECURITY_SENSITIVE.includes(rel)) bad.push(rel);
    }
    return bad;
  }

  // Baseline: every file that ACTUALLY exists under the surface today must already be classified.
  assert.deepEqual(unclassified(), [], `unclassified security-sensitive file(s) — add each to PROTECTED_PATHS or NOT_SECURITY_SENSITIVE: ${JSON.stringify(unclassified())}`);

  // Proof the mechanism forces a decision on a NEW file regardless of its name — reproduces BOTH
  // judges' exact planted filenames from the live probe that found this gap.
  const plantDir = join(repoRoot, "qa-engine", "src", "contexts", "workspace-and-publication", "domain");
  const plants = ["secret-guard.service.ts", "secrets.ts", "confine.ts", "egress.ts"];
  const plantedFullPaths = plants.map((p) => join(plantDir, p));
  try {
    for (const p of plantedFullPaths) writeFileSync(p, "export {};\n");
    const bad = unclassified();
    for (const p of plants) {
      assert.ok(
        bad.includes(`qa-engine/src/contexts/workspace-and-publication/domain/${p}`),
        `${p} must be flagged as unclassified the moment it appears — that is the whole point of inverting the default (got: ${JSON.stringify(bad)})`,
      );
    }
  } finally {
    for (const p of plantedFullPaths) if (existsSync(p)) rmSync(p);
  }
});

test("isProtectedPath flags the gate-integrity surface (the fix must not weaken its own gate)", () => {
  // *.test.ts (suffix glob, anywhere) — the npm-test gate the pre-deploy self-test runs.
  assert.equal(isProtectedPath("src/qa/change-coverage.test.ts"), true);
  assert.equal(isProtectedPath("src/pipeline.test.ts"), true);
  assert.equal(isProtectedPath("./src/server/merge-guard.test.ts"), true); // leading ./ normalized
  // the typecheck gate config, the safety-layer entrypoint, and the untrusted-code runner.
  assert.equal(isProtectedPath("tsconfig.json"), true);
  assert.equal(isProtectedPath("src/index.ts"), true);
  // migration-tier-4b Slice 1: src/qa/code-runner.ts is deleted — replaced by these three qa-engine
  // homes (the design's gate CORRECTION 3).
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts"), true);
  // migration-tier-4d Slice 1b: src/qa/execute.ts is deleted — replaced by this qa-engine home,
  // which spawns agent-authored specs (untrusted) exactly like code-execution.runner.ts above. It
  // was NOT protected before this slice — closing a real pre-existing gap, not just parity.
  assert.equal(isProtectedPath("qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts"), true);
  // a non-test source file next to tests is still editable (glob is a strict .test.ts suffix).
  assert.equal(isProtectedPath("src/qa/change-coverage.ts"), false);
});

test("assessChange blocks a fix that touches a protected file", () => {
  const r = assessChange({ files: ["src/pipeline.ts", "boot-guard.mjs"], additions: 5, deletions: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("protected")));
});

test("assessChange blocks an over-large fix (files or lines)", () => {
  const tooManyFiles = assessChange({ files: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`), additions: 10, deletions: 0 });
  assert.equal(tooManyFiles.ok, false);
  assert.ok(tooManyFiles.reasons.some((x) => x.includes("file")));

  const tooManyLines = assessChange({ files: ["src/a.ts"], additions: 500, deletions: 50 });
  assert.equal(tooManyLines.ok, false);
  assert.ok(tooManyLines.reasons.some((x) => x.includes("line")));
});

test("assessChange allows a minimal, in-scope fix", () => {
  const r = assessChange({ files: ["src/pipeline.ts", "src/qa/validate.ts"], additions: 12, deletions: 4 });
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("assessChange blocks an empty change", () => {
  assert.equal(assessChange({ files: [], additions: 0, deletions: 0 }).ok, false);
});

test("parseNumstat handles text and binary rows", () => {
  const out = ["3\t1\tsrc/a.ts", "10\t0\tsrc/b.ts", "-\t-\tassets/logo.png"].join("\n");
  const stat = parseNumstat(out);
  assert.deepEqual(stat.files, ["src/a.ts", "src/b.ts", "assets/logo.png"]);
  assert.equal(stat.additions, 13);
  assert.equal(stat.deletions, 1);
});

test("a renamed protected file (delete row under --no-renames) is still caught", () => {
  // With --no-renames, renaming boot-guard.mjs surfaces as a delete of the protected path
  // plus an add of the new one. assessChange must block on the delete row.
  const out = ["0\t40\tboot-guard.mjs", "40\t0\tboot-guard-x.mjs"].join("\n");
  const r = assessChange(parseNumstat(out));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("protected")));
});

test("assessRate blocks a burst (window) and back-to-back deploys (cooldown)", () => {
  const now = 1_000_000_000_000;
  // three deploys within the last hour → at the window limit
  const burst = [now - 1000, now - 2000, now - 3000];
  assert.equal(assessRate(burst, now).ok, false);

  // a single recent deploy violates the cooldown
  const recent = [now - 1000];
  const r = assessRate(recent, now);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("cooldown")));
});

test("assessRate allows a deploy after the cooldown with few recent deploys", () => {
  const now = 1_000_000_000_000;
  const old = [now - DEFAULT_RATE_LIMITS.cooldownMs - 1000];
  assert.deepEqual(assessRate(old, now), { ok: true, reasons: [] });
  // empty history is always allowed
  assert.equal(assessRate([], now).ok, true);
});

test("deploy ledger persists timestamps and round-trips", () => {
  const store = new Map<string, string>();
  const fs: LedgerFs = {
    read: (p) => store.get(p) ?? null,
    write: (p, s) => void store.set(p, s),
  };
  const path = "/data/maintainer-deploys.json";
  assert.deepEqual(readDeployHistory(path, fs), []);
  recordDeploy(path, 100, fs);
  recordDeploy(path, 200, fs);
  assert.deepEqual(readDeployHistory(path, fs), [100, 200]);
});

test("readDeployHistory tolerates corrupt/missing ledger files", () => {
  const fs: LedgerFs = { read: () => "not json", write: () => {} };
  assert.deepEqual(readDeployHistory("/x", fs), []);
  const none: LedgerFs = { read: () => null, write: () => {} };
  assert.deepEqual(readDeployHistory("/x", none), []);
});

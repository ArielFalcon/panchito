import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
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
  PROTECTED_PATHS,
} from "./merge-guard";

// Shared walk/completeness helpers (used by the completeness test AND the FIX II(b) backstop
// reproduction test below) — factored to module scope so both share ONE walk implementation.
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

function unclassifiedUnder(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
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

// judgment-day round 3 (FIX C, Judge A): three control-plane auth files were BOTH unscanned (not
// under a SECURITY_SENSITIVE_SURFACE_ROOTS root) AND unprotected — a weakening edit to any of them
// passed silently. auth.ts mints/validates the HMAC session token; github-auth.ts is the push/admin
// authorization rule gating control-plane access; webhook.ts's verifySignature is the HMAC gate on
// who can trigger a run at all. None lives under either existing surface root (both are qa-engine
// dirs; these are src/server/ standalone files) — added as exact PROTECTED_PATHS entries rather than
// promoting all of src/server/ to a root, which would force review of ~40 unrelated files (views,
// metrics, telemetry, queue, …) with no genuine security content.
test("isProtectedPath flags the control-plane auth boundary (FIX C)", () => {
  assert.equal(isProtectedPath("src/server/auth.ts"), true);
  assert.equal(isProtectedPath("src/server/github-auth.ts"), true);
  assert.equal(isProtectedPath("src/server/webhook.ts"), true);
});

// judgment-day round 3 (FIX C, Judge A): generation/infrastructure/ is where model-bound prompts are
// assembled and sanitized — literally the directory the 4th and 5th unsanitized-prompt-site defects
// lived in (only sanitize-text.ts was protected; every sibling, including prompts.ts itself, was
// not). qa-run-orchestration/infrastructure/bridges/ is the port-implementation layer wiring EVERY
// domain security boundary (write-confinement, publication, GitHub) into the use case — only
// publication-port.adapter.ts was protected. Per-file judgment on exactly this class of surface has
// now failed 5 times (the meta-lesson) — rather than add a partial, reasoned allowlist here too, both
// directories are wholesale PROTECTED_PATHS prefixes: every file in them, present or future, requires
// human review. The residual is zero by construction, not by review, and needs no NOT_SECURITY_SENSITIVE
// entries at all.
test("isProtectedPath flags the whole generation/infrastructure and orchestration bridges surface (FIX C)", () => {
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/route-catalog.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/generation/infrastructure/sse/reexplore.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts"), true);
  assert.equal(isProtectedPath("qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/deploy-gate-port.adapter.ts"), true);
});

// judgment-day round 4 (FIX II(a), Judge A): three more files verified UNPROTECTED via isProtectedPath
// despite being squarely inside the secret/confinement/review boundary this module protects.
test("isProtectedPath flags repo-mirror.ts, codex-strategy.ts and agent-runtime/config.ts (FIX II(a))", () => {
  // owns authHeaderArgs() (GITHUB_TOKEN into git URLs), hardenGitArgs() (disables hooksPath — its own
  // comment calls this a root-RCE escape), and scrubGitError() (its comment cites a PAST incident of a
  // PAT logged in plaintext).
  assert.equal(isProtectedPath("src/integrations/repo-mirror.ts"), true);
  // codexExecEnv's env allowlist for untrusted `codex exec` spawns — same risk class as scrub-env.ts,
  // already protected above.
  assert.equal(isProtectedPath("src/agent-runtime/codex-strategy.ts"), true);
  // reviewerPrimaryCollisionErrors is the SOLE guard that reviewer/primary use different models —
  // deleting it silently collapses dual-mode review into a rubber stamp.
  assert.equal(isProtectedPath("src/agent-runtime/config.ts"), true);
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
test("PROTECTED_PATHS completeness (FIX 6, invert-the-default): every file under the security-sensitive surface is either protected or explicitly reviewed as not-sensitive", () => {
  // Baseline: every file that ACTUALLY exists under the surface today must already be classified.
  const baseline = unclassifiedUnder(SECURITY_SENSITIVE_SURFACE_ROOTS);
  assert.deepEqual(baseline, [], `unclassified security-sensitive file(s) — add each to PROTECTED_PATHS or NOT_SECURITY_SENSITIVE: ${JSON.stringify(baseline)}`);

  // Proof the mechanism forces a decision on a NEW file regardless of its name — reproduces BOTH
  // judges' exact planted filenames from the live probe that found this gap.
  const plantDir = join(repoRoot, "qa-engine", "src", "contexts", "workspace-and-publication", "domain");
  const plants = ["secret-guard.service.ts", "secrets.ts", "confine.ts", "egress.ts"];
  const plantedFullPaths = plants.map((p) => join(plantDir, p));
  try {
    for (const p of plantedFullPaths) writeFileSync(p, "export {};\n");
    const bad = unclassifiedUnder(SECURITY_SENSITIVE_SURFACE_ROOTS);
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

// judgment-day round 4 (FIX II(b), Judge B): the two blanket PROTECTED_PATHS directory prefixes added
// in round 3 (generation/infrastructure/, qa-run-orchestration/infrastructure/bridges/) had NO
// completeness backstop of their own — unlike workspace-and-publication/ and process-sandbox/, they
// were never added to SECURITY_SENSITIVE_SURFACE_ROOTS, so nothing walked them. Judge B proved this
// empirically: narrowing the prefix to exclude ONE file (catalog-gate.ts) left every merge-guard test
// green. Both roots are now added to SECURITY_SENSITIVE_SURFACE_ROOTS (their own comment's "100%
// coverage by construction" claim now HOLDS structurally — the completeness walk above scans them
// too) and NOT_SECURITY_SENSITIVE stays empty for them (the blanket prefix already covers every file).
test("FIX II(b): the completeness backstop now scans generation/infrastructure/ and orchestration bridges/ (Judge B's exact mutation is caught)", () => {
  const root = "qa-engine/src/contexts/generation/infrastructure/";
  const idx = PROTECTED_PATHS.indexOf(root);
  assert.ok(idx >= 0, "expected the blanket prefix entry to exist in PROTECTED_PATHS before mutating it");

  // Reproduce Judge B's exact mutation: replace the single blanket-prefix entry with individual
  // per-file entries for EVERY file except one (catalog-gate.ts) — narrowing the prefix past exactly
  // one file, exactly as his mutation testing did.
  const files: string[] = [];
  walk(join(repoRoot, root), files);
  const relFiles = files.map((f) => relative(repoRoot, f).replace(/\\/g, "/"));
  const narrowed = relFiles.filter((f) => !f.endsWith("catalog-gate.ts"));
  PROTECTED_PATHS.splice(idx, 1, ...narrowed);
  try {
    // Sanity: the mutation must actually narrow past this file (otherwise this test proves nothing).
    assert.equal(isProtectedPath(`${root}catalog-gate.ts`), false, "sanity: the mutation must narrow protection past catalog-gate.ts");

    // Route through the SAME SECURITY_SENSITIVE_SURFACE_ROOTS list the real completeness test scans —
    // this is the actual backstop mechanism, not just a direct walk of the mutated directory. Before
    // FIX II(b) (root not yet registered in SECURITY_SENSITIVE_SURFACE_ROOTS), this assertion FAILS —
    // that is Judge B's exact gap: the narrowed prefix is invisible to the completeness walk.
    const bad = unclassifiedUnder(SECURITY_SENSITIVE_SURFACE_ROOTS);
    assert.ok(
      bad.includes(`${root}catalog-gate.ts`),
      `the completeness backstop must catch the narrowed prefix — got unclassified: ${JSON.stringify(bad)}`,
    );
  } finally {
    PROTECTED_PATHS.splice(idx, narrowed.length, root); // restore the original blanket entry
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

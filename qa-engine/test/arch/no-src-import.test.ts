// qa-engine/test/arch/no-src-import.test.ts
// Boundary machine-enforcement (migration-tier-1-2, Slice 5): qa-engine production code MUST NOT
// import src/. The `*-parity.test.ts` files are the only sanctioned, temporary exception (and only
// pre-deletion, under qa-engine/test/) — this rule's `from` scope covers qa-engine/src/ only, so it
// never conflicts with them. Sibling of vcs-write-confinement.test.ts: shells depcruise with the
// dedicated config and asserts on its exit.
// Manual-audit note: depcruise may miss dynamic import()/barrel re-exports; if a new src/ coupling
// is added via either mechanism, audit it by hand — this static rule will not catch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");

// A prior INTERRUPTED run (SIGINT before a test's finally-cleanup fired) can leave a stale probe
// file under qa-engine/src/, which would make the CLEAN ON HEAD assertion below report a false
// violation on an untouched tree. Sweep any leftover probes once, before any test runs.
for (const entry of readdirSync(join(root, "qa-engine", "src"))) {
  if (/^__(no_src_import|arch_check)_probe.*__\.ts$/.test(entry)) {
    rmSync(join(root, "qa-engine", "src", entry), { force: true });
  }
}

// The --config argument is always resolved as an ABSOLUTE path (not root-relative) so this helper
// works identically regardless of the invoking `cwd` — the CLI resolves --config off process.cwd()
// itself, before the config's own `options.baseDir` (which governs the from/to rule matching) is
// even loaded. `target` stays baseDir-relative ("qa-engine/src") in every call, proving the SAME
// argument resolves identically no matter which directory the command runs from.
function runDepcruise(target: string, cwd: string = root): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      "npx",
      ["depcruise", "--config", join(root, "qa-engine", ".dependency-cruiser.cjs"), target],
      { cwd, encoding: "utf8" },
    );
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string | number };
    const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (err.code === "ENOENT" || /Cannot find|not found|ENOENT/i.test(combined)) {
      assert.fail(`dependency-cruiser not found — run \`npm install\` (exit: ${err.code}):\n${combined}`);
    }
    return { ok: false, output: combined };
  }
}

test("SYNTHETIC VIOLATION: a qa-engine production file importing src/ is caught by the boundary rule", () => {
  // A throwaway probe under qa-engine/src/ (a SIBLING of contexts/, deliberately — the sibling
  // vcs-write-confinement.test.ts's own depcruise scan targets qa-engine/src/contexts specifically,
  // and node:test runs separate test FILES concurrently by default; a probe placed inside contexts/
  // can be observed mid-write by that concurrent scan and produce a flaky cross-file failure) that
  // imports a real, still-present src/ module. Proves the guard actually FIRES on a real violation,
  // not just that depcruise runs clean by omission.
  const probePath = join(root, "qa-engine", "src", "__no_src_import_probe_1__.ts");
  writeFileSync(
    probePath,
    'import type { TestTarget } from "../../src/types.ts";\nexport type Probe = TestTarget;\n',
  );
  try {
    const { ok, output } = runDepcruise("qa-engine/src");
    assert.equal(ok, false, "depcruise must report a violation for the synthetic src/ import probe");
    assert.match(output, /no-src-import-in-qa-engine/, `expected the no-src-import-in-qa-engine rule to fire, got:\n${output}`);
  } finally {
    // Never left committed regardless of assertion outcome.
    rmSync(probePath, { force: true });
  }
});

test("CLEAN ON HEAD: no qa-engine production file imports src/ today", () => {
  const { ok, output } = runDepcruise("qa-engine/src");
  assert.equal(ok, true, `dependency-cruiser reported a src/ boundary violation on HEAD:\n${output}`);
});

test("KNOWN PITFALL, documented and out-of-gate (judgment-day round-2): a bare 'src' TARGET ARGUMENT invoked from cwd=qa-engine/ silently scans the wrong tree and misses a real violation", () => {
  // Pinning options.baseDir (round-1) fixed rule-MATCHING, but baseDir also governs how the CLI's
  // own target argument resolves: a bare `src` target from cwd=qa-engine/ resolves against baseDir
  // (the repo root) as "<repo-root>/src" — the LEGACY root src/ tree — NOT qa-engine/src. This does
  // not error; it silently reports clean because none of that tree's module ids match the
  // `^qa-engine/src/` `from` pattern, even with the SAME real probe violation present. This is the
  // exact invocation form quoted (as "now fixed") in the round-1 commit message/header — it is
  // NOT fixed for this bare-target form; the canonical fix is the baseDir-relative target used by
  // `npm run arch:check`, asserted as the CLEAN ON HEAD / SYNTHETIC VIOLATION tests above. This
  // test documents the pitfall as known-and-out-of-gate: it must keep reporting a false "ok" so a
  // future accidental fix here doesn't silently hide the still-real ad-hoc CLI foot-gun untested.
  const probePath = join(root, "qa-engine", "src", "__no_src_import_probe_2__.ts");
  writeFileSync(
    probePath,
    'import type { TestTarget } from "../../src/types.ts";\nexport type Probe = TestTarget;\n',
  );
  try {
    const { ok } = runDepcruise("src", join(root, "qa-engine"));
    assert.equal(
      ok,
      true,
      "documented pitfall: a bare 'src' target from cwd=qa-engine/ is expected to silently scan the wrong (root) tree and miss the probe violation",
    );
  } finally {
    rmSync(probePath, { force: true });
  }
});

test("SYNTHETIC VIOLATION, invoked with cwd=qa-engine/: the boundary rule still fires (judgment-day round-1 — was a silent false-clean no-op before options.baseDir was pinned)", () => {
  // Reproduced false-clean: before pinning `options.baseDir` in .dependency-cruiser.cjs, running
  // depcruise from ANY cwd other than the repo root made the from/to path regexes (anchored to
  // "qa-engine/src/"/"^src/") never match the cwd-relative module ids depcruise generated — the
  // rule silently never fired, reporting a false "clean" even on a real violation. Same probe/target
  // as the root-cwd SYNTHETIC VIOLATION test above, only `cwd` differs — proving the SAME
  // baseDir-relative target ("qa-engine/src") now resolves identically regardless of invocation cwd.
  const probePath = join(root, "qa-engine", "src", "__no_src_import_probe_3__.ts");
  writeFileSync(
    probePath,
    'import type { TestTarget } from "../../src/types.ts";\nexport type Probe = TestTarget;\n',
  );
  try {
    const { ok, output } = runDepcruise("qa-engine/src", join(root, "qa-engine"));
    assert.equal(ok, false, "depcruise must report a violation for the synthetic probe even when invoked with cwd=qa-engine/");
    assert.match(output, /no-src-import-in-qa-engine/, `expected the no-src-import-in-qa-engine rule to fire, got:\n${output}`);
  } finally {
    rmSync(probePath, { force: true });
  }
});

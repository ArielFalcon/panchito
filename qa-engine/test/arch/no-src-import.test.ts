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

// Anchored to the EXACT probe filenames THIS FILE ITSELF writes (`__no_src_import_probe_1/2/3__.ts`,
// all under qa-engine/src/, never under src/) — never a generic "contains 'probe'" substring. Matched
// against the FROM side ONLY (the depcruise output line is
// "  error no-src-import-in-qa-engine: <from> → <to>"), never the whole line: a generic whole-line
// substring match would ALSO hit the TO side, so a normally-named, REAL qa-engine production file
// importing a src/ file that merely happens to be NAMED like a probe artifact would have its entire
// violation silently dropped — a genuine masking bug the SYNTHETIC MASKING REGRESSION test below
// reproduces and pins closed.
const PROBE_FROM_PATTERN = /^qa-engine\/src\/__no_src_import_probe_\d+__\.ts$/;

// Extracts only the REAL (non-probe-FROM) violations from a raw depcruise output. Shared by the
// CLEAN ON HEAD test and the SYNTHETIC MASKING REGRESSION test below so both exercise the exact same
// filtering logic — a fix to one is a fix to both, and the regression test is a direct pin on this
// function's own behavior, not a parallel hand-rolled copy that could drift from the real gate.
function filterRealViolations(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => /no-src-import-in-qa-engine/.test(l))
    .filter((l) => {
      const fromMatch = /no-src-import-in-qa-engine:\s*(\S+)\s*→/.exec(l);
      const from = fromMatch?.[1];
      // Unparseable line shape — never silently drop an unrecognized line (CLAUDE.md "surface
      // integration errors loudly"); treat it as a real violation instead.
      if (from === undefined) return true;
      return !PROBE_FROM_PATTERN.test(from);
    });
}

test("CLEAN ON HEAD: no qa-engine production file imports src/ today", () => {
  const { ok, output } = runDepcruise("qa-engine/src");
  if (ok) return;
  // This file's OWN probe-writing tests (the SYNTHETIC/PITFALL cases below, ids 1/2/3) each
  // transiently create a `__no_src_import_probe_N__.ts` file under qa-engine/src for the span of
  // their own write -> scan -> cleanup. If this scan's own run interleaves with one of those, a
  // stale/transient probe could surface here too. Those are definitionally test artifacts, never
  // real production code, so a genuine HEAD violation would be on a normally-named FROM file. Fail
  // ONLY on a non-probe-FROM violation, so the gate stays strict without this file's own probe
  // lifecycle producing a false red (judgment-day tier-4b round-2). CORRECTION: an earlier revision
  // of this comment also blamed the sibling vcs-write-confinement.test.ts — verified false: that
  // file creates ZERO temp files and scans a disjoint subtree (qa-engine/src/contexts, not
  // qa-engine/src), so it cannot produce this race at all.
  const realViolations = filterRealViolations(output);
  assert.deepEqual(
    realViolations,
    [],
    `dependency-cruiser reported a REAL src/ boundary violation on HEAD:\n${realViolations.join("\n")}`,
  );
});

test("SYNTHETIC MASKING REGRESSION: a real violation is not hidden merely because the imported src/ file's name looks like a probe artifact (the filter must scope to the FROM side only, anchored to this file's own literal probe names)", () => {
  // A normally-named, REAL production-style qa-engine file (never one of this file's own probe
  // filenames) importing a src/ file that happens to be NAMED to look like a probe artifact on the
  // TO side. Reproduced independently before this fix: the prior generic whole-line substring filter
  // matched "probe" on the TO side and silently dropped the ENTIRE violation line, even though the
  // FROM side is not a probe at all — all CLEAN ON HEAD-style assertions passed despite a real
  // violation on disk.
  const realFromPath = join(root, "qa-engine", "src", "__masking_regression_real_module__.ts");
  const fakeProbeNamedSrcFile = join(root, "src", "__fake_leaked_probe_9__.ts");
  writeFileSync(fakeProbeNamedSrcFile, "export type Leaked = string;\n");
  writeFileSync(
    realFromPath,
    'import type { Leaked } from "../../src/__fake_leaked_probe_9__.ts";\nexport type Probe = Leaked;\n',
  );
  try {
    const { ok, output } = runDepcruise("qa-engine/src");
    assert.equal(ok, false, "depcruise must itself report a violation for this real src/ import");
    const realViolations = filterRealViolations(output);
    assert.ok(
      realViolations.some((l) => l.includes("__masking_regression_real_module__.ts")),
      `the gate must catch a real violation whose imported (TO-side) file merely looks like a probe artifact — got real violations:\n${realViolations.join("\n")}\nfull depcruise output:\n${output}`,
    );
  } finally {
    rmSync(realFromPath, { force: true });
    rmSync(fakeProbeNamedSrcFile, { force: true });
  }
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

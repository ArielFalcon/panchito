// qa-engine/test/arch/vcs-write-confinement.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The security gate (§2 G3 / §8 R4): assert NO module under generation/* or agent-runtime/* imports
// VcsWritePort or a write adapter. Runs depcruise with the dedicated config and fails on any
// violation. Must be green BEFORE any context adapter is written in later plans.
// Manual-audit note: depcruise may miss dynamic import()/barrel re-exports; if a new write path is
// added via either mechanism, audit it by hand — this static rule will not catch it.
test("no generation/* or agent-runtime/* module imports the VCS write seam", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  let out = "";
  try {
    out = execFileSync(
      "npx",
      ["depcruise", "--config", "qa-engine/.dependency-cruiser.cjs", "qa-engine/src/contexts"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string | number };
    // Differentiate an install/ENOENT failure from an actual rule violation so the error message
    // is actionable. An ENOENT typically means `depcruise` is not installed or not on PATH.
    const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (err.code === "ENOENT" || /Cannot find|not found|ENOENT/i.test(combined)) {
      assert.fail(`dependency-cruiser not found — run \`npm install\` (exit: ${err.code}):\n${combined}`);
    }
    assert.fail(`dependency-cruiser reported a VCS-write confinement violation:\n${combined}`);
  }
  // depcruise exits 0 with no error output when the rule holds.
  assert.doesNotMatch(out, /error no-vcs-write-in-agent-contexts/);
});

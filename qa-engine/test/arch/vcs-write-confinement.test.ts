// qa-engine/test/arch/vcs-write-confinement.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The security gate (§8 R4): assert NO context module other than workspace-and-publication imports
// the VCS write seam. The rule is now inverted — it covers ALL contexts/* except the write owner,
// so new contexts added in future plans are secure by default without a whitelist update.
// Runs depcruise with the dedicated config and fails on any violation. Must be green BEFORE any
// context adapter is written in later plans.
// Manual-audit note: depcruise may miss dynamic import()/barrel re-exports; if a new write path is
// added via either mechanism, audit it by hand — this static rule will not catch it.
test("no context other than workspace-and-publication imports the VCS write seam", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  try {
    execFileSync(
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
    // A real rule violation causes depcruise to exit non-zero — this assert.fail is the
    // meaningful gate. The catch branch is the violation path; exit-0 (no violation) never
    // enters the catch, so no stdout assertion is needed after the try/catch.
    assert.fail(`dependency-cruiser reported a VCS-write confinement violation:\n${combined}`);
  }
  // depcruise exits 0 when the rule holds — reaching this line is the pass condition.
});

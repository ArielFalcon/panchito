// Integration tests for the manifest write-time validation (post-ADR-001, Phase 3.1): the
// orchestrator validates each entry against ManifestEntrySchema — the SAME schema the read
// path uses — before writing, so it can never emit a manifest its own read-validation would
// reject. runOpencode writes via the hardcoded realManifestFs, so these exercise the real
// filesystem in an isolated tmp mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpencode, type AgentDeps, type OpencodeRunInput } from "./opencode-client";

function fixedDeps(response: string): AgentDeps {
  return {
    open: async () => ({ id: "test-session", prompt: async () => response, dispose: async () => {} }),
  };
}

// A tmp mirror with one real spec file on disk (so the manifest's on-disk reconciliation,
// which checksums the file, keeps the entry — isolating the SCHEMA validation as the variable).
function withMirror(run: (mirror: string, manifestPath: string) => Promise<void>): Promise<void> {
  const mirror = mkdtempSync(join(tmpdir(), "qa-manifest-"));
  mkdirSync(join(mirror, "e2e", "flows"), { recursive: true });
  writeFileSync(join(mirror, "e2e", "flows", "x.spec.ts"), "import { test } from '@playwright/test';\n");
  const manifestPath = join(mirror, "e2e", ".qa", "manifest.json");
  return run(mirror, manifestPath).finally(() => rmSync(mirror, { recursive: true, force: true }));
}

function inputFor(mirror: string): OpencodeRunInput {
  return {
    repo: "org/demo",
    sha: "abc123",
    diff: "diff --git a/x b/x\n+const x = 1;",
    mirrorDir: mirror,
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc123",
    needsReview: false, // keep runOpencode to generation + manifest only (no reviewer here)
    target: "e2e",
    mode: "diff",
    appName: "demo-app",
    intent: { type: "feat", breaking: false, message: "feat: x", changedFiles: ["src/x.ts"] },
  };
}

test("a well-formed specMeta is written to the manifest (with its sha256 checksum)", () =>
  withMirror(async (mirror, manifestPath) => {
    const deps = fixedDeps(
      '{"specs":["flows/x.spec.ts"],"specMetas":[{"file":"flows/x.spec.ts","flow":"x","objective":"valid creds reach the dashboard","targets":["AuthService.login"]}]}',
    );
    await runOpencode(inputFor(mirror), deps);

    assert.ok(existsSync(manifestPath), "the manifest must be written for a valid entry");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, "x");
    assert.deepEqual(manifest[0].targets, ["AuthService.login"]);
    assert.equal(typeof manifest[0].sha256, "string", "sha256 must survive the write→read round-trip");
  }));

test("a specMeta the read schema would reject (empty targets) is DROPPED, never written", () =>
  withMirror(async (mirror, manifestPath) => {
    // Empty targets passes generator extraction (lenient) but violates the manifest invariant
    // (targets min 1). The write-time guard must drop it rather than corrupt the manifest.
    const deps = fixedDeps(
      '{"specs":["flows/x.spec.ts"],"specMetas":[{"file":"flows/x.spec.ts","flow":"x","objective":"valid creds reach the dashboard","targets":[]}]}',
    );
    await runOpencode(inputFor(mirror), deps);

    assert.equal(existsSync(manifestPath), false, "no manifest should be written when the only entry is invalid");
  }));

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectArtifactBytes, buildArtifactBytesMetrics, type ArtifactBytesDeps, type ArtifactSizeCache } from "./metrics";
import type { AppConfig } from "../orchestrator/config-loader";

// Minimal AppConfig stub — only fields used by the metrics module.
function makeApp(name: string, repo: string): AppConfig {
  return { name, repo } as unknown as AppConfig;
}

function makeDeps(sizes: Record<string, number>): ArtifactBytesDeps {
  return {
    listAppConfigs: () => [makeApp("portfolio", "ArielFalcon/portfolio"), makeApp("docs", "ArielFalcon/docs")],
    mirrorRoot: () => "/mirrors",
    getDirectorySize: (dir: string) => {
      if (dir in sizes) return sizes[dir]!;
      return 0;
    },
  };
}

test("collectArtifactBytes: returns per-app byte totals using slug-based mirror path", () => {
  const deps = makeDeps({
    "/mirrors/ArielFalcon__portfolio/e2e/.qa": 1024,
    "/mirrors/ArielFalcon__docs/e2e/.qa": 512,
  });
  const result = collectArtifactBytes(deps);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { name: "portfolio", bytes: 1024 });
  assert.deepEqual(result[1], { name: "docs", bytes: 512 });
});

test("collectArtifactBytes: getDirectorySize throwing is caught → 0 bytes for that app", () => {
  const deps: ArtifactBytesDeps = {
    listAppConfigs: () => [makeApp("broken", "Owner/broken")],
    mirrorRoot: () => "/mirrors",
    getDirectorySize: (_dir: string) => { throw new Error("ENOENT"); },
  };
  const result = collectArtifactBytes(deps);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { name: "broken", bytes: 0 });
});

test("buildArtifactBytesMetrics: emits one line per app and correct HELP/TYPE header", () => {
  const deps = makeDeps({
    "/mirrors/ArielFalcon__portfolio/e2e/.qa": 2048,
    "/mirrors/ArielFalcon__docs/e2e/.qa": 0,
  });
  const cache: { current: ArtifactSizeCache | null } = { current: null };
  const output = buildArtifactBytesMetrics(deps, cache, 60_000, 1_000_000);
  assert.match(output, /# HELP panchito_qa_artifact_bytes/);
  assert.match(output, /# TYPE panchito_qa_artifact_bytes gauge/);
  assert.match(output, /panchito_qa_artifact_bytes\{app="portfolio"\} 2048/);
  assert.match(output, /panchito_qa_artifact_bytes\{app="docs"\} 0/);
});

test("buildArtifactBytesMetrics: uses cached result within TTL, does not re-scan", () => {
  let scanCount = 0;
  const deps: ArtifactBytesDeps = {
    listAppConfigs: () => [makeApp("app", "O/app")],
    mirrorRoot: () => "/m",
    getDirectorySize: (_dir: string) => { scanCount++; return 100; },
  };
  const cache: { current: ArtifactSizeCache | null } = { current: null };
  const now = 1_000_000;
  buildArtifactBytesMetrics(deps, cache, 60_000, now);
  buildArtifactBytesMetrics(deps, cache, 60_000, now + 30_000); // within TTL
  assert.equal(scanCount, 1, "should scan only once within TTL");
});

test("buildArtifactBytesMetrics: refreshes cache after TTL expires", () => {
  let scanCount = 0;
  const deps: ArtifactBytesDeps = {
    listAppConfigs: () => [makeApp("app", "O/app")],
    mirrorRoot: () => "/m",
    getDirectorySize: (_dir: string) => { scanCount++; return 200; },
  };
  const cache: { current: ArtifactSizeCache | null } = { current: null };
  const now = 1_000_000;
  buildArtifactBytesMetrics(deps, cache, 60_000, now);
  buildArtifactBytesMetrics(deps, cache, 60_000, now + 61_000); // past TTL
  assert.equal(scanCount, 2, "should scan again after TTL");
});

test("buildArtifactBytesMetrics: returns empty string when no apps configured", () => {
  const deps: ArtifactBytesDeps = {
    listAppConfigs: () => [],
    mirrorRoot: () => "/m",
    getDirectorySize: (_dir: string) => 0,
  };
  const cache: { current: ArtifactSizeCache | null } = { current: null };
  const output = buildArtifactBytesMetrics(deps, cache, 60_000, 1_000_000);
  assert.equal(output, "");
});

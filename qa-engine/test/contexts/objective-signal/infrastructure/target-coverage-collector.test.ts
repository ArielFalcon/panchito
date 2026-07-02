// test/contexts/objective-signal/infrastructure/target-coverage-collector.test.ts
// Behavioral tests for makeTargetCoverageCollector — the real, src/-free CoverageCollectorPort
// factory closing the F.2 GAP (engram obs #914). Selects the concrete collector(s) by TestTarget:
// "e2e" -> V8BrowserCoverageAdapter (real readV8Dumps); "code" -> the composite of
// LcovCoverageAdapter/C8CoverageAdapter/JacocoCoverageAdapter (real readers) via CoverageCollectorAdapter.
// Uses REAL temp-dir fixtures end to end (no per-function mocking) — this proves the whole wiring,
// not just each reader in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector.ts";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "qa-engine-target-coverage-collector-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("e2e target: collects from real V8 dumps under .qa/coverage/<namespace>", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    const entries = [
      {
        url: "https://dev/src/svc.ts",
        source: "export function f() {\n  return 1;\n}\n",
        functions: [{ ranges: [{ startOffset: 0, endOffset: 34, count: 3 }] }],
      },
    ];
    writeFileSync(join(dumpDir, "dump.json"), JSON.stringify(entries));

    const collector = makeTargetCoverageCollector({ target: "e2e", repoDir: e2eDir, e2eDir, changedFiles: ["src/svc.ts"] });
    const report = await collector.collect(e2eDir, "qa-abc");
    const file = report.covered.find((c) => c.file === "src/svc.ts");
    assert.ok(file, "V8 dump must resolve to the changed file via URL suffix match");
    assert.ok(file!.lines.includes(1));
  });
});

test("e2e target: no dumps -> empty report (never blocks, unknown)", async () => {
  await withTmpDir(async (e2eDir) => {
    const collector = makeTargetCoverageCollector({ target: "e2e", repoDir: e2eDir, e2eDir, changedFiles: ["src/svc.ts"] });
    const report = await collector.collect(e2eDir, "qa-none");
    assert.deepEqual(report.covered, []);
  });
});

test("code target: collects from a real lcov.info report", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    writeFileSync(join(repoDir, "coverage", "lcov.info"), "SF:src/a.ts\nDA:1,2\nDA:2,0\nend_of_record\n");

    const collector = makeTargetCoverageCollector({ target: "code", repoDir, e2eDir: repoDir, changedFiles: ["src/a.ts"] });
    const report = await collector.collect(repoDir, "qa-abc");
    const file = report.covered.find((c) => c.file === "src/a.ts");
    assert.ok(file, "lcov report must be read and parsed");
    assert.deepEqual(file!.lines, [1]);
  });
});

test("code target: collects from a real coverage-final.json (Istanbul) report", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    const absPath = join(repoDir, "src/b.ts");
    const json = {
      [absPath]: {
        path: absPath,
        statementMap: { "0": { start: { line: 3 }, end: { line: 3 } } },
        s: { "0": 1 },
      },
    };
    writeFileSync(join(repoDir, "coverage", "coverage-final.json"), JSON.stringify(json));

    const collector = makeTargetCoverageCollector({ target: "code", repoDir, e2eDir: repoDir, changedFiles: ["src/b.ts"] });
    const report = await collector.collect(repoDir, "qa-abc");
    const file = report.covered.find((c) => c.file === "src/b.ts");
    assert.ok(file, "coverage-final.json must be read and parsed, and repoDir-normalized");
    assert.deepEqual(file!.lines, [3]);
  });
});

test("code target: collects from a real JaCoCo XML report", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "target", "site", "jacoco"), { recursive: true });
    const xml = [
      '<package name="com/example">',
      '<sourcefile name="Foo.java">',
      '<line nr="10" ci="1"/>',
      '<line nr="11" ci="0"/>',
      "</sourcefile>",
      "</package>",
    ].join("\n");
    writeFileSync(join(repoDir, "target", "site", "jacoco", "jacoco.xml"), xml);

    const collector = makeTargetCoverageCollector({
      target: "code",
      repoDir,
      e2eDir: repoDir,
      changedFiles: ["com/example/Foo.java"],
    });
    const report = await collector.collect(repoDir, "qa-abc");
    const file = report.covered.find((c) => c.file === "com/example/Foo.java");
    assert.ok(file, "JaCoCo XML must be read and parsed");
    assert.deepEqual(file!.lines, [10]);
  });
});

test("code target: no reports at all -> empty report (fail-open, never blocks)", async () => {
  await withTmpDir(async (repoDir) => {
    const collector = makeTargetCoverageCollector({ target: "code", repoDir, e2eDir: repoDir, changedFiles: ["src/a.ts"] });
    const report = await collector.collect(repoDir, "qa-none");
    assert.deepEqual(report.covered, []);
  });
});

test("code target: merges multiple simultaneous report kinds without dropping lines", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    writeFileSync(join(repoDir, "coverage", "lcov.info"), "SF:src/a.ts\nDA:1,2\nend_of_record\n");
    mkdirSync(join(repoDir, "target", "site", "jacoco"), { recursive: true });
    writeFileSync(
      join(repoDir, "target", "site", "jacoco", "jacoco.xml"),
      '<package name=""><sourcefile name="b.java"><line nr="5" ci="1"/></sourcefile></package>',
    );

    const collector = makeTargetCoverageCollector({
      target: "code",
      repoDir,
      e2eDir: repoDir,
      changedFiles: ["src/a.ts", "b.java"],
    });
    const report = await collector.collect(repoDir, "qa-abc");
    assert.ok(report.covered.find((c) => c.file === "src/a.ts"), "lcov result must be present");
    assert.ok(report.covered.find((c) => c.file === "b.java"), "jacoco result must be present too");
  });
});

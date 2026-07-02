// test/contexts/objective-signal/infrastructure/coverage-dump-reader.test.ts
// Behavioral tests for the src/-independent dump readers (Sub-Plan 7.2 item 2). These are the
// missing `(specDir, namespace) => Promise<T[]>` closures the existing collector adapters declare
// but never got a real default for — see F.2's GAP note (engram obs #914). Each reader is exercised
// against a real temp-dir fixture (no FS mocking — the readers ARE the FS boundary), asserting the
// exact injected-type shape each adapter expects (V8DumpFile[] / CoverageFile[] / IstanbulFile[] /
// JacocoFile[]) and the fail-open contract (absent dir/files -> empty array, never throw).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readV8Dumps,
  readLcovFiles,
  readIstanbulFiles,
  readJacocoFiles,
} from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "qa-engine-coverage-dump-reader-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── readV8Dumps: e2eDir + namespace -> V8_DUMP_DIR = join(e2eDir, ".qa", "coverage", namespace) ──

test("readV8Dumps: reads every *.json dump under .qa/coverage/<namespace>", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    const entries = [{ url: "https://dev/src/svc.ts", source: "x", functions: [] }];
    writeFileSync(join(dumpDir, "dump-1.json"), JSON.stringify(entries));
    writeFileSync(join(dumpDir, "dump-2.json"), JSON.stringify([]));
    writeFileSync(join(dumpDir, "not-a-dump.txt"), "ignore me");

    const dumps = await readV8Dumps(e2eDir, "qa-abc");
    assert.equal(dumps.length, 2, "only .json files are read");
    const withEntries = dumps.find((d) => d.entries.length > 0);
    assert.ok(withEntries, "dump-1.json's entries must be parsed");
    assert.deepEqual(withEntries!.entries, entries);
  });
});

test("readV8Dumps: returns [] when the namespace directory does not exist (fail-open)", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumps = await readV8Dumps(e2eDir, "qa-does-not-exist");
    assert.deepEqual(dumps, []);
  });
});

test("readV8Dumps: skips a corrupt (non-JSON) dump file instead of throwing", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "corrupt.json"), "{not valid json");
    writeFileSync(join(dumpDir, "good.json"), JSON.stringify([{ url: "https://dev/a.ts", source: "y" }]));

    const dumps = await readV8Dumps(e2eDir, "qa-abc");
    assert.equal(dumps.length, 1, "the corrupt file is skipped, not thrown");
    assert.equal(dumps[0]!.entries.length, 1);
  });
});

test("readV8Dumps: a non-array JSON dump degrades to empty entries (fail-open)", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "object.json"), JSON.stringify({ not: "an array" }));

    const dumps = await readV8Dumps(e2eDir, "qa-abc");
    assert.equal(dumps.length, 1);
    assert.deepEqual(dumps[0]!.entries, []);
  });
});

// ── readLcovFiles: repoDir + conventional relative paths (namespace unused — native reports are ──
// ── per-run-directory scoped by the tool itself, not by our namespace convention) ────────────────

test("readLcovFiles: reads coverage/lcov.info when present", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    const lcov = "SF:src/a.ts\nDA:1,2\nend_of_record\n";
    writeFileSync(join(repoDir, "coverage", "lcov.info"), lcov);

    const files = await readLcovFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readLcovFiles: falls back to lcov.info at repo root when coverage/lcov.info is absent", async () => {
  await withTmpDir(async (repoDir) => {
    const lcov = "SF:src/b.ts\nDA:5,1\nend_of_record\n";
    writeFileSync(join(repoDir, "lcov.info"), lcov);

    const files = await readLcovFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readLcovFiles: falls back to coverage/lcov/lcov.info as the third conventional path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage", "lcov"), { recursive: true });
    const lcov = "SF:src/c.ts\nDA:9,4\nend_of_record\n";
    writeFileSync(join(repoDir, "coverage", "lcov", "lcov.info"), lcov);

    const files = await readLcovFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readLcovFiles: returns [] when no conventional lcov path exists (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const files = await readLcovFiles(repoDir, "qa-abc");
    assert.deepEqual(files, []);
  });
});

// ── readIstanbulFiles: repoDir/coverage/coverage-final.json ───────────────────────────────────

test("readIstanbulFiles: reads coverage/coverage-final.json when present", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    const json = { "/repo/src/a.ts": { path: "/repo/src/a.ts", statementMap: {}, s: {} } };
    writeFileSync(join(repoDir, "coverage", "coverage-final.json"), JSON.stringify(json));

    const files = await readIstanbulFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.deepEqual(files[0]!.json, json);
  });
});

test("readIstanbulFiles: returns [] when coverage-final.json is absent (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const files = await readIstanbulFiles(repoDir, "qa-abc");
    assert.deepEqual(files, []);
  });
});

test("readIstanbulFiles: a corrupt coverage-final.json degrades to [] instead of throwing", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    writeFileSync(join(repoDir, "coverage", "coverage-final.json"), "{not valid json");

    const files = await readIstanbulFiles(repoDir, "qa-abc");
    assert.deepEqual(files, []);
  });
});

// ── readJacocoFiles: Maven/Gradle conventional JaCoCo XML report paths ─────────────────────────

test("readJacocoFiles: reads the Maven default report path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "target", "site", "jacoco"), { recursive: true });
    const xml = "<report></report>";
    writeFileSync(join(repoDir, "target", "site", "jacoco", "jacoco.xml"), xml);

    const files = await readJacocoFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readJacocoFiles: reads the Gradle default report path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "build", "reports", "jacoco", "test"), { recursive: true });
    const xml = "<report gradle=\"true\"></report>";
    writeFileSync(join(repoDir, "build", "reports", "jacoco", "test", "jacocoTestReport.xml"), xml);

    const files = await readJacocoFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readJacocoFiles: falls back to target/jacoco.xml as the third conventional path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "target"), { recursive: true });
    const xml = "<report fallback=\"true\"></report>";
    writeFileSync(join(repoDir, "target", "jacoco.xml"), xml);

    const files = await readJacocoFiles(repoDir, "qa-abc");
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readJacocoFiles: returns [] when no conventional JaCoCo path exists (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const files = await readJacocoFiles(repoDir, "qa-abc");
    assert.deepEqual(files, []);
  });
});
